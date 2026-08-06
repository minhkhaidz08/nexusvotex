const crypto = require('crypto');
const axios = require('axios');
const { admin } = require('../config/supabase');
const { createNotification, logActivity } = require('./notification.service');
const { generatePaymentCode } = require('../utils/helpers');
const { creditWallet } = require('./wallet.service');
const { AppError } = require('../middleware/errorHandler');

const PARTNER_ID = process.env.THESIEURE_PARTNER_ID;
const PARTNER_KEY = process.env.THESIEURE_PARTNER_KEY;
const API_URL = process.env.THESIEURE_API_URL || 'https://thesieure.com/chargingws/v2';

/**
 * Submit a card to TheSieuRe.
 * @returns {string} the internal payment code for the charge
 */
async function submitCard({ userId, cardType, pin, serial, amount }) {
  const paymentCode = generatePaymentCode('TSR');

  const { error: payErr } = await admin.from('payments').insert({
    payment_code: paymentCode,
    user_id: userId,
    amount: amount || null,
    method: 'thesieure',
    status: 'pending',
    provider: 'thesieure',
    detail: { card_type: cardType, serial },
  });
  if (payErr) throw new Error('Failed to create payment record');

  // TheSieuRe charging sign: md5(partner_key + code + command + partner_id + request_id + serial + telco)
  const sign = crypto
    .createHash('md5')
    .update(`${PARTNER_KEY}${pin}charging${PARTNER_ID}${paymentCode}${serial}${cardType}`, 'utf8')
    .digest('hex')
    .toLowerCase();

  const payload = {
    telco: cardType,
    code: pin,
    serial,
    amount,
    request_id: paymentCode,
    partner_id: PARTNER_ID,
    sign,
    command: 'charging',
  };

  let response;
  try {
    response = await axios.post(`${API_URL}`, new URLSearchParams(payload), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
  } catch (err) {
    await admin
      .from('payments')
      .update({ status: 'failed', provider_message: 'Card provider request failed' })
      .eq('payment_code', paymentCode);
    throw new AppError('Không kết nối được nhà cung cấp thẻ, vui lòng thử lại sau', 502);
  }

  const data = response.data || {};
  const providerStatus = Number(data.status);
  const message = data.message || '';

  if (providerStatus === 1) {
    // Instant success - credit immediately, webhook will be idempotent
    await confirmCard({
      paymentCode,
      cardType,
      serial,
      code: pin,
      amount: Number(data.amount || amount),
      status: 1,
      transId: String(data.trans_id || ''),
      internal: true,
    });
    return paymentCode;
  }

  // 99 = pending, will be confirmed by webhook
  if (providerStatus !== 99) {
    await admin
      .from('payments')
      .update({ status: 'failed', provider_message: message })
      .eq('payment_code', paymentCode);
    throw new AppError(`Thẻ không hợp lệ hoặc đã được sử dụng: ${message || 'provider từ chối'}`, 400);
  }

  // Pending - will be confirmed by webhook
  await admin
    .from('payments')
    .update({ provider_code: data.trans_id || null, provider_message: message })
    .eq('payment_code', paymentCode);

  return paymentCode;
}

/**
 * Called by TheSieuRe webhook / our callback.
 * Verifies signature, marks payment success and credits wallet.
 * @returns {boolean} true if the callback was accepted, false if signature invalid/unknown
 */
async function confirmCard({ paymentCode, cardType, serial, code, amount, status, transId, callbackSign, internal }) {
  if (!PARTNER_ID || !PARTNER_KEY) {
    throw new Error('TheSieuRe credentials not configured');
  }

  // TheSieuRe callback sign: md5(partner_key + code + serial)
  // External webhooks MUST carry a valid sign; internal confirmations are trusted.
  if (!internal) {
    if (!callbackSign) return false;
    const expected = crypto
      .createHash('md5')
      .update(`${PARTNER_KEY}${code}${serial}`, 'utf8')
      .digest('hex')
      .toLowerCase();
    if (expected !== String(callbackSign).toLowerCase()) return false;
  }

  const { data: payment, error: pErr } = await admin
    .from('payments')
    .select('*')
    .eq('payment_code', paymentCode)
    .single();

  if (pErr || !payment) return false;
  if (payment.status === 'success') return true; // idempotent

  const isSuccess = Number(status) === 1 || Number(status) === 2; // 1 = đúng giá, 2 = sai giá (vẫn nhận)

  if (isSuccess) {
    const creditAmount = Number(amount || 0) > 0 ? Number(amount) : Number(payment.amount || 0);
    if (creditAmount <= 0) {
      await admin
        .from('payments')
        .update({ status: 'failed', provider_message: 'Invalid card amount' })
        .eq('payment_code', paymentCode);
      return true;
    }

    // CAS transition -> success: only one concurrent callback can win, and a
    // payment expired by the cron (status=failed) can still be claimed when a
    // slow card provider finally reports success. Postgres re-evaluates the
    // WHERE after taking the row lock, so this is safe against double-credit.
    const { data: claimed, error: claimErr } = await admin
      .from('payments')
      .update({
        status: 'success',
        provider_code: transId || payment.provider_code,
        provider_message: 'Card approved',
        processed_at: new Date().toISOString(),
      })
      .eq('payment_code', paymentCode)
      .in('status', ['pending', 'failed'])
      .select('id, user_id, amount')
      .maybeSingle();

    // Lost the race (already processed by another webhook) -> no double credit.
    if (claimErr || !claimed) return true;

    let newBalance;
    try {
      // CAS credit: safe against concurrent deposits to the same wallet.
      newBalance = await creditWallet({
        userId: claimed.user_id,
        amount: creditAmount,
        type: 'deposit',
        description: `Nạp thẻ ${cardType} ${serial} - mã GD ${paymentCode}`,
        refType: 'payment',
        refId: claimed.id,
      });
    } catch (creditErr) {
      // Revert to pending so the provider retry (or manual admin confirm) can finish.
      await admin
        .from('payments')
        .update({ status: 'pending', provider_message: 'Credit failed, will retry' })
        .eq('payment_code', paymentCode);
      throw creditErr;
    }

    await createNotification({
      userId: claimed.user_id,
      title: 'Nạp tiền thành công',
      content: `Thẻ cào ${cardType} mệnh giá ${creditAmount.toLocaleString('vi-VN')}đ đã được xác nhận. Số dư hiện tại: ${newBalance.toLocaleString('vi-VN')}đ`,
      type: 'deposit',
    });

    await logActivity({
      userId: claimed.user_id,
      action: 'wallet_deposit_card',
      detail: `${creditAmount} VND via TheSieuRe (${paymentCode})`,
    });
  } else {
    await admin
      .from('payments')
      .update({
        status: 'failed',
        provider_message: 'Card rejected by provider',
      })
      .eq('payment_code', paymentCode);
  }

  return true;
}

module.exports = { submitCard, confirmCard, PARTNER_ID };
