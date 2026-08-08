const { asyncHandler } = require('../middleware/errorHandler');
const { admin } = require('../config/supabase');
const { confirmCard } = require('../services/thesieure.service');
const { confirmPayment, verifySignature } = require('../services/payos.service');
const { logActivity } = require('../services/notification.service');

/**
 * POST /api/webhook/thesieure
 * TheSieuRe calls back with status of the card charge.
 */
const theSieuRe = asyncHandler(async (req, res) => {
  // TheSieuRe can deliver the callback either as POST (JSON body) or GET
  // (query string) - accept both so a pending charge never stalls waiting.
  const body = { ...req.query, ...req.body };
  const { request_id, serial, code, status, amount, telco, trans_id, callback_sign } = body;

  if (!request_id) return res.json({ status: 'error', message: 'missing request_id' });

  const accepted = await confirmCard({
    paymentCode: String(request_id),
    cardType: String(telco || '').toUpperCase(),
    serial: String(serial || ''),
    code: String(code || ''),
    amount: Number(amount || 0),
    status: Number(status || 0),
    transId: String(trans_id || ''),
    callbackSign: String(callback_sign || ''),
  });

  if (!accepted) {
    await logActivity({ userId: null, action: 'webhook_bad_signature', detail: 'TheSieuRe', ip: req.ip });
    return res.status(400).json({ status: 'error', message: 'invalid callback_sign' });
  }

  // Always acknowledge to avoid retry spam
  return res.json({ status: 'success' });
});

/**
 * POST /api/webhook/payos
 * PayOS webhook for payment confirmation.
 */
const payos = asyncHandler(async (req, res) => {
  const payload = req.body;

  if (!verifySignature(payload)) {
    await logActivity({ userId: null, action: 'webhook_bad_signature', detail: 'PayOS', ip: req.ip });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const data = payload.data || {};
  const orderCode = String(data.orderCode || '');

  let matchedCode = null;

  // Match by PayOS payment id (provider_code)
  if (data.id) {
    const { data: pay } = await admin
      .from('payments')
      .select('payment_code')
      .eq('provider_code', String(data.id))
      .eq('method', 'payos')
      .maybeSingle();
    matchedCode = pay?.payment_code || null;
  }

  // Fallback: match by our numeric order code stored in detail
  if (!matchedCode && orderCode) {
    const { data: pay } = await admin
      .from('payments')
      .select('payment_code')
      .eq('method', 'payos')
      .eq('detail->>order_code', orderCode)
      .maybeSingle();
    matchedCode = pay?.payment_code || null;
  }

  if (!matchedCode) {
    await logActivity({ userId: null, action: 'webhook_unmatched', detail: `orderCode=${orderCode}`, ip: req.ip });
    return res.json({ error: 'Payment not found' });
  }

  await confirmPayment({
    paymentCode: matchedCode,
    status: data.status || 'PAID',
    amount: Number(data.amount || 0),
  });

  return res.json({ success: true });
});

module.exports = { webhookController: { theSieuRe, payos } };
