/**
 * Scheduled jobs:
 *  - Expire old pending payments after 30 min
 *  - Reconcile successful payments missing their wallet credit (crash window)
 *  - Refund purchase debits with no matching order (crash window)
 *  - Retain activity logs for 90 days
 */

const CREDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function expirePendingPayments(admin) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: pending, error } = await admin
    .from('payments')
    .select('id')
    .eq('status', 'pending')
    .lt('created_at', cutoff);

  if (error || !pending || pending.length === 0) return;

  for (const p of pending) {
    await admin.from('payments').update({ status: 'failed', provider_message: 'Expired' }).eq('id', p.id);
  }
}

/**
 * Recovery for the deposit crash window: a payment can be flipped to
 * `success` and then the process die before the wallet is credited (the two
 * are separate PostgREST calls, no transaction). That leaves the money
 * sitting in a `success` payment with no matching wallet_transactions row.
 *
 * Any `success` payment without a deposit transaction (ref_type='payment',
 * type='deposit', ref_id=payment.id) is credited here. It is idempotent:
 * creditWallet only records the transaction after its CAS update wins, and
 * the presence of that transaction is what gates future runs.
 *
 * NOTE: designed for the single-instance deployment this app assumes (same
 * assumption as the in-memory rate limiters). If you scale to multiple
 * instances, gate this job with a leader lock or a payment-level CAS marker.
 */
async function reconcileCredits(admin) {
  const since = new Date(Date.now() - CREDIT_WINDOW_MS).toISOString();
  const { data: payments, error } = await admin
    .from('payments')
    .select('id, user_id, amount, payment_code')
    .eq('status', 'success')
    .gte('processed_at', since)
    .limit(500);

  if (error || !payments || payments.length === 0) return;

  const credited = new Set();
  const CHUNK = 100;
  for (let i = 0; i < payments.length; i += CHUNK) {
    const ids = payments.slice(i, i + CHUNK).map((p) => p.id);
    const { data: txs } = await admin
      .from('wallet_transactions')
      .select('ref_id')
      .eq('ref_type', 'payment')
      .eq('type', 'deposit')
      .in('ref_id', ids);
    (txs || []).forEach((t) => credited.add(t.ref_id));
  }

  const { creditWallet } = require('./wallet.service');
  for (const p of payments) {
    if (credited.has(p.id)) continue;
    const amount = Number(p.amount);
    if (!(amount > 0)) continue;
    try {
      await creditWallet({
        userId: p.user_id,
        amount,
        type: 'deposit',
        description: `Bù tiền nạp tự động (reconciliation) - ${p.payment_code}`,
        refType: 'payment',
        refId: p.id,
      });
      console.log(`[cron] Reconciled credit for payment ${p.payment_code}`);
    } catch (e) {
      console.error(`[cron] reconcile failed for ${p.payment_code}: ${e.message}`);
    }
  }
}

async function cleanupActivityLogs(admin) {
  const cutoff = new Date(Date.now() - LOG_RETENTION_MS).toISOString();
  await admin.from('activity_logs').delete().lt('created_at', cutoff);
}

/**
 * Recovery for the purchase-side crash window (mirror of reconcileCredits):
 * a checkout debits the wallet (debit_wallet) and THEN creates the orders.
 * If the process dies in between, the debit is recorded with ref_id=order_code
 * but no order row ever exists, leaving the money in limbo with no recovery.
 *
 * This job refunds every purchase debit (ref_type='order'|'custom_order') that
 * has NO matching order and NO existing refund. It is idempotent: the refund
 * itself is a credit_wallet call carrying (ref_type='refund', ref_id=order_code)
 * which records exactly once (unique index + atomic function), so a completed
 * checkout (order exists) or an already-refunded debit (refund exists) is
 * skipped on every run.
 */
async function reconcileOrphanedPurchases(admin) {
  const { data: debits, error } = await admin
    .from('wallet_transactions')
    .select('id, user_id, amount, ref_type, ref_id')
    .eq('type', 'purchase')
    .in('ref_type', ['order', 'custom_order']);
  if (error || !debits || debits.length === 0) return;

  const refs = [...new Set(debits.filter((t) => t.ref_id).map((t) => t.ref_id))];
  if (refs.length === 0) return;

  const CHUNK = 100;
  const exists = new Set();
  for (let i = 0; i < refs.length; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK);
    // Checkout debits carry ref_id = checkout order_code, which lands in
    // orders.group_code (each per-key order row gets its own order_code).
    // Custom orders carry ref_id = custom_orders.order_code.
    const [ordersRes, customsRes] = await Promise.all([
      admin.from('orders').select('group_code').in('group_code', chunk),
      admin.from('custom_orders').select('order_code').in('order_code', chunk),
    ]);
    (ordersRes.data || []).forEach((o) => exists.add(o.group_code));
    (customsRes.data || []).forEach((o) => exists.add(o.order_code));
  }

  const alreadyRefunded = new Set();
  for (let i = 0; i < refs.length; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK);
    const { data: refunds } = await admin
      .from('wallet_transactions')
      .select('ref_id')
      .eq('ref_type', 'refund')
      .in('ref_id', chunk);
    (refunds || []).forEach((t) => alreadyRefunded.add(t.ref_id));
  }

  const { creditWallet } = require('./wallet.service');
  for (const t of debits) {
    if (!t.ref_id || exists.has(t.ref_id) || alreadyRefunded.has(t.ref_id)) continue;
    const amount = Math.abs(Number(t.amount));
    if (!(amount > 0)) continue;
    try {
      await creditWallet({
        userId: t.user_id,
        amount,
        type: 'refund',
        description: `Hoàn tiền tự động đơn ${t.ref_id} (đơn không tồn tại)`,
        refType: 'refund',
        refId: t.ref_id,
      });
      console.log(`[cron] Reconciled orphaned debit refund for ${t.ref_id}`);
    } catch (e) {
      console.error(`[cron] orphan refund failed for ${t.ref_id}: ${e.message}`);
    }
  }
}

function initCronJobs(cron) {
  if (process.env.NODE_ENV === 'production') {
    // Ping self-keepalive isn't needed server-side; UptimeRobot handles it.
  }

  const { admin } = require('../config/supabase');
  cron.schedule('*/10 * * * *', () => {
    expirePendingPayments(admin).catch((e) => console.error('[cron]', e.message));
  });
  cron.schedule('*/10 * * * *', () => {
    reconcileCredits(admin).catch((e) => console.error('[cron] reconcile', e.message));
  });
  cron.schedule('*/10 * * * *', () => {
    reconcileOrphanedPurchases(admin).catch((e) => console.error('[cron] orphan-refund', e.message));
  });
  cron.schedule('0 4 * * *', () => {
    cleanupActivityLogs(admin).catch((e) => console.error('[cron] cleanup', e.message));
  });

  console.log('[NexusVotex] Cron jobs initialized');
}

module.exports = { initCronJobs, expirePendingPayments, reconcileCredits, reconcileOrphanedPurchases, cleanupActivityLogs };
