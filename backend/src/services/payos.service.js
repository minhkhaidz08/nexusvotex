const axios = require('axios');
const crypto = require('crypto');
const { admin } = require('../config/supabase');
const { createNotification, logActivity } = require('./notification.service');
const { generatePaymentCode } = require('../utils/helpers');
const { creditWallet } = require('./wallet.service');

const PAYOS_URL = process.env.PAYOS_API_URL || 'https://api-merchant.payos.vn';

function buildHeaders() {
  return {
    'x-client-id': process.env.PAYOS_CLIENT_ID,
    'x-api-key': process.env.PAYOS_API_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Create a PayOS payment link (QR code). Returns checkout URL + QR.
 */
async function createPaymentLink({ userId, amount, description, cancelUrl, returnUrl }) {
  const paymentCode = generatePaymentCode('POS');
  // PayOS requires a numeric order code within ±(2^53-1). epoch-seconds
  // (10 digits, ~1.7e9) + 6 random digits stays well below the cap while
  // keeping collisions impossible even for simultaneous deposits.
  const numericOrderCode = Number(`${Math.floor(Date.now() / 1000)}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`);

  const { error: payErr } = await admin.from('payments').insert({
    payment_code: paymentCode,
    user_id: userId,
    amount,
    method: 'payos',
    status: 'pending',
    provider: 'payos',
    detail: { order_code: numericOrderCode },
  });
  if (payErr) throw new Error('Failed to create payment record');

  const cleanDescription = (description || `Nap tien NexusVotex`).slice(0, 25);
  const signData = {
    amount,
    cancelUrl,
    description: cleanDescription,
    orderCode: numericOrderCode,
    returnUrl,
  };
  // PayOS create-payment-link signature: HMAC-SHA256 over the alphabetically
  // sorted query string of amount/cancelUrl/description/orderCode/returnUrl.
  const signature = crypto
    .createHmac('sha256', process.env.PAYOS_CHECKSUM_KEY)
    .update(
      Object.keys(signData)
        .sort()
        .map((k) => `${k}=${signData[k]}`)
        .join('&')
    )
    .digest('hex');

  const payload = {
    ...signData,
    items: [{ name: 'Nạp tiền vào ví NexusVotex', quantity: 1, price: amount }],
    signature,
  };

  let response;
  try {
    response = await axios.post(`${PAYOS_URL}/v2/payment-requests`, payload, {
      headers: buildHeaders(),
      timeout: 30000,
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || 'PayOS request failed';
    await admin
      .from('payments')
      .update({ status: 'failed', provider_message: String(detail) })
      .eq('payment_code', paymentCode);
    throw new Error('Cannot create payment link, try again later');
  }

  const data = response.data || {};
  if (data.code !== '00' && data.code !== 0) {
    await admin
      .from('payments')
      .update({ status: 'failed', provider_message: data.desc || 'PayOS error' })
      .eq('payment_code', paymentCode);
    throw new Error(data.desc || 'PayOS error');
  }

  await admin
    .from('payments')
    .update({ provider_code: String(data.data?.id || ''), provider_message: data.desc })
    .eq('payment_code', paymentCode);

  return {
    paymentCode,
    checkoutUrl: data.data?.checkoutUrl,
    qrCode: data.data?.qrCode,
    content: cleanDescription,
  };
}

/**
 * Verify PayOS webhook signature.
 * PayOS signs ONLY the `data` sub-object (not code/desc/success/signature):
 *   - sort the keys of `data` alphabetically
 *   - convert to query string `key=value&key=value` (arrays -> sorted JSON string, null -> empty)
 *   - HMAC-SHA256 with the checksum key
 * This mirrors payOSHQ/payos-lib-node createSignatureFromObj().
 */
function verifySignature(payload) {
  const { data, signature } = payload || {};
  if (!data || typeof data !== 'object' || !process.env.PAYOS_CHECKSUM_KEY || !signature) {
    return false;
  }

  const sortKeys = (obj) =>
    Object.keys(obj)
      .sort()
      .reduce((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {});

  const sorted = sortKeys(data);
  const queryStr = Object.keys(sorted)
    .filter((k) => sorted[k] !== undefined)
    .map((k) => {
      let value = sorted[k];
      if (Array.isArray(value)) {
        value = JSON.stringify(value.map((item) => (item && typeof item === 'object' ? sortKeys(item) : item)));
      }
      if ([null, undefined, 'null', 'undefined'].includes(value)) {
        value = '';
      }
      return `${k}=${value}`;
    })
    .join('&');

  const expected = crypto
    .createHmac('sha256', process.env.PAYOS_CHECKSUM_KEY)
    .update(queryStr)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Confirm PayOS payment (from webhook). Credit the wallet.
 */
async function confirmPayment({ paymentCode, status, amount }) {
  const { data: payment, error: pErr } = await admin
    .from('payments')
    .select('*')
    .eq('payment_code', paymentCode)
    .single();

  if (pErr || !payment) return false;
  if (payment.status === 'success') return true;

  const isSuccess = status === 'PAID' || status === 'SUCCESS' || status === true;

  if (isSuccess) {
    // CAS transition -> success: only one concurrent webhook can win, and a
    // payment expired by the cron (status=failed) can still be claimed when a
    // late webhook finally reports success.
    const { data: claimed, error: claimErr } = await admin
      .from('payments')
      .update({
        status: 'success',
        provider_message: 'Payment confirmed',
        processed_at: new Date().toISOString(),
      })
      .eq('payment_code', paymentCode)
      .in('status', ['pending', 'failed'])
      .select('id, user_id, amount')
      .maybeSingle();

    // Lost the race (already confirmed) -> no double credit.
    if (claimErr || !claimed) return true;

    const credit = Number(amount || claimed.amount);
    let newBalance;
    try {
      // CAS credit: safe against concurrent deposits to the same wallet.
      newBalance = await creditWallet({
        userId: claimed.user_id,
        amount: credit,
        type: 'deposit',
        description: `Nạp tiền chuyển khoản qua PayOS - mã GD ${paymentCode}`,
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
      content: `Bạn đã nạp ${credit.toLocaleString('vi-VN')}đ vào ví. Số dư hiện tại: ${newBalance.toLocaleString('vi-VN')}đ`,
      type: 'deposit',
    });

    await logActivity({
      userId: claimed.user_id,
      action: 'wallet_deposit_payos',
      detail: `${credit} VND via PayOS (${paymentCode})`,
    });
  } else {
    await admin
      .from('payments')
      .update({ status: 'failed', provider_message: 'Payment cancelled/expired' })
      .eq('payment_code', paymentCode);
  }

  return true;
}

module.exports = { createPaymentLink, confirmPayment, verifySignature };
