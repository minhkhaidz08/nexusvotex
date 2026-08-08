const { admin } = require('../config/supabase');
const { createNotification, logActivity } = require('./notification.service');

/**
 * Map a PostgREST RPC error to a thrown Error with the right user-facing
 * message. Operational errors (bad request) carry statusCode + isOperational
 * so the checkout/webhook flows can rethrow them as clean 4xx responses.
 */
function rpcErrorToHttp(error) {
  const msg = (error && error.message) || '';
  if (msg.includes('wallet not found')) return new Error('Wallet not found');
  if (msg.includes('insufficient balance')) {
    const e = new Error('Số dư không đủ, vui lòng nạp thêm');
    e.statusCode = 400;
    e.isOperational = true;
    return e;
  }
  if (msg.includes('invalid amount')) return new Error('Invalid amount');
  if (msg.includes('amount must not be zero')) return new Error('Amount must not be zero');
  return new Error('Wallet service error');
}

/**
 * Admin tool / refund helper. Positive = credit, negative = debit.
 * Runs as one atomic DB transaction (public.adjust_wallet) so the balance
 * update and the wallet_transactions row can never diverge.
 */
async function adjustBalance({ userId, amount, description, actorId = null }) {
  const delta = Number(amount);
  if (!delta || delta === 0) throw new Error('Amount must not be zero');

  const { data, error } = await admin.rpc('adjust_wallet', {
    p_user_id: userId,
    p_amount: delta,
    p_description: description || 'Điều chỉnh số dư',
  });
  if (error) throw rpcErrorToHttp(error);

  const newBalance = Number(data);
  if (delta > 0) {
    await createNotification({
      userId,
      title: 'Nhận tiền vào ví',
      content: `Tài khoản của bạn vừa được cộng ${delta.toLocaleString('vi-VN')}đ. Số dư: ${newBalance.toLocaleString('vi-VN')}đ`,
      type: 'wallet',
    });
  }

  await logActivity({
    userId: actorId || userId,
    action: 'wallet_adjust',
    detail: `${delta > 0 ? '+' : ''}${delta} VND for user ${userId}`,
  });

  return newBalance;
}

/**
 * Debit balance for a purchase. Atomic DB transaction (public.debit_wallet):
 * checks sufficient balance under a row lock, moves the money, records the
 * transaction in one step.
 */
async function debitForPurchase({ userId, amount, description, refType, refId }) {
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error('Invalid amount');

  const { data, error } = await admin.rpc('debit_wallet', {
    p_user_id: userId,
    p_amount: amt,
    p_description: description,
    p_ref_type: refType || null,
    p_ref_id: refId || null,
  });
  if (error) throw rpcErrorToHttp(error);
  return Number(data);
}

/**
 * Credit balance (deposits/refunds). Atomic DB transaction
 * (public.credit_wallet). Idempotent per (ref_type, ref_id): calling it twice
 * with the same ref returns the already-recorded balance and never moves the
 * money a second time, which makes webhook replays and the reconciliation job
 * safe against double-credit even under concurrent execution.
 */
async function creditWallet({ userId, amount, type = 'deposit', description, refType, refId }) {
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error('Invalid amount');

  const { data, error } = await admin.rpc('credit_wallet', {
    p_user_id: userId,
    p_amount: amt,
    p_type: type,
    p_description: description || 'Nạp tiền vào ví',
    p_ref_type: refType || null,
    p_ref_id: refId || null,
  });
  if (error) throw rpcErrorToHttp(error);
  return Number(data);
}

module.exports = { adjustBalance, debitForPurchase, creditWallet };
