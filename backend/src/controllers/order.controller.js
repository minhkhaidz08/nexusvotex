const { admin } = require('../config/supabase');
const { ok, generateOrderCode } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { createNotification, logActivity } = require('../services/notification.service');
const { debitForPurchase, creditWallet } = require('../services/wallet.service');

/**
 * Pick the price actually charged to a buyer based on their role.
 * Sellers pay the shop's per-product seller_price when one is set,
 * otherwise they fall back to the regular price.
 */
const buyerPrice = (role, product) =>
  role === 'seller' && Number(product.seller_price) > 0
    ? Number(product.seller_price)
    : Number(product.price);

/**
 * Pick the price actually charged for a variant based on the buyer's role.
 */
const variantPrice = (role, variant) =>
  role === 'seller' && Number(variant.seller_price) > 0
    ? Number(variant.seller_price)
    : Number(variant.price);

/**
 * GET /api/orders - list the current user's order history
 */
const myOrders = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('orders')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new AppError('Failed to fetch orders', 500);

  const { data: customOrders } = await admin
    .from('custom_orders')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(100);

  ok(res, { orders: data || [], customOrders: customOrders || [] });
});

/**
 * GET /api/orders/:id - order detail (order or custom order)
 */
const detail = asyncHandler(async (req, res) => {
  const { id } = req.params;

  let order = null;
  let customOrder = null;

  const { data: o, error: oErr } = await admin
    .from('orders')
    .select('*, products(name, image_url)')
    .eq('id', id)
    .maybeSingle();
  if (!oErr && o) order = o;

  const { data: c, error: cErr } = await admin
    .from('custom_orders')
    .select('*, products(name, image_url)')
    .eq('id', id)
    .maybeSingle();
  if (!cErr && c) customOrder = c;

  const target = order || customOrder;
  if (!target) throw new AppError('Order not found', 404);
  if (target.user_id !== req.userId && req.user.role !== 'admin') {
    throw new AppError('Forbidden', 403);
  }

  ok(res, target);
});

/**
 * Validate discount code and compute discounted total.
 */
async function applyDiscount(discountCode, total) {
  if (!discountCode) return { total, discountAmount: 0 };

  const { data: dc, error } = await admin
    .from('discount_codes')
    .select('*')
    .eq('code', String(discountCode).trim().toUpperCase())
    .eq('is_active', true)
    .maybeSingle();
  if (error || !dc) throw new AppError('Mã giảm giá không hợp lệ');
  if (dc.max_uses && dc.used_count >= dc.max_uses) throw new AppError('Mã giảm giá đã hết lượt sử dụng');
  if (dc.expires_at && new Date(dc.expires_at) < new Date()) throw new AppError('Mã giảm giá đã hết hạn');
  if (dc.min_amount && total < dc.min_amount) {
    throw new AppError(`Đơn hàng tối thiểu ${dc.min_amount.toLocaleString('vi-VN')}đ để dùng mã này`);
  }

  let discountAmount =
    dc.discount_type === 'percent'
      ? Math.round((total * dc.value) / 100)
      : Math.min(dc.value, total);

  return {
    total: Math.max(total - discountAmount, 0),
    discountAmount,
    discountId: dc.id,
    discountCode: dc.code,
  };
}

/**
 * POST /api/orders/cart/preview - compute total + discount without purchasing
 */
const previewCart = asyncHandler(async (req, res) => {
  const { items, discount_code } = req.body;
  if (!Array.isArray(items) || items.length === 0) throw new AppError('Cart is empty');

  const result = await computeCart(items, req.user?.role);
  const discount = await applyDiscount(discount_code, result.subtotal);
  ok(res, { ...result, ...discount });
});

async function computeCart(items, role) {
  if (items.length > 50) throw new AppError('Giỏ hàng quá nhiều sản phẩm (tối đa 50)');
  const productIds = items.map((i) => i.product_id);
  const { data: products, error } = await admin
    .from('products')
    .select('id, name, price, seller_price, type, image_url, is_active, product_variants(id, name, price, seller_price, sort_order)')
    .eq('is_active', true)
    .in('id', productIds);
  if (error || !products) throw new AppError('Invalid cart items');

  const byId = {};
  products.forEach((p) => {
    byId[p.id] = { ...p, variants: p.product_variants || [] };
  });

  let subtotal = 0;
  const lines = [];
  for (const item of items) {
    const product = byId[item.product_id];
    if (!product) throw new AppError('Một sản phẩm trong giỏ không tồn tại');
    if (product.type !== 'instant') throw new AppError(`Sản phẩm "${product.name}" cần đặt theo đơn đặt hàng`);
    if (!product.variants.length) throw new AppError(`Sản phẩm "${product.name}" chưa có loại key, vui lòng liên hệ shop`);

    // Resolve the chosen variant: explicit id wins, otherwise fall back to the
    // single variant (keeps single-variant products simple).
    let variant;
    if (item.variant_id) {
      variant = product.variants.find((v) => v.id === item.variant_id);
      if (!variant) throw new AppError(`Loại key không hợp lệ cho sản phẩm "${product.name}"`);
    } else if (product.variants.length === 1) {
      variant = product.variants[0];
    } else {
      throw new AppError(`Vui lòng chọn loại key cho "${product.name}"`);
    }

    const qty = Math.max(1, Math.min(Number(item.qty) || 1, 50));
    const unit = variantPrice(role, variant);
    subtotal += unit * qty;
    lines.push({
      product: { ...product, price: unit },
      variant,
      variantId: variant.id,
      variantName: variant.name,
      qty,
    });
  }
  return { subtotal, lines, count: lines.reduce((s, l) => s + l.qty, 0) };
}

/**
 * Split a discounted total across cart lines proportionally to each line's
 * subtotal, using largest-remainder rounding so the sum equals `total` exactly.
 */
function allocateLineTotals(lines, subtotal, total) {
  if (!subtotal || !total) return lines.map(() => 0);
  const raw = lines.map((l) => (l.product.price * l.qty * total) / subtotal);
  const floored = raw.map(Math.floor);
  const remainder = total - floored.reduce((a, b) => a + b, 0);
  const idxs = raw
    .map((r, i) => ({ i, frac: r - floored[i] }))
    .sort((a, b) => b.frac - a.frac)
    .slice(0, remainder)
    .map((x) => x.i);
  return floored.map((f, i) => (idxs.includes(i) ? f + 1 : f));
}

/**
 * Split a line's discounted total across `qty` keys so the sum equals the line
 * total exactly, returning per-key totals and the discount off full price.
 */
function allocateKeyTotals(qty, lineTotal) {
  if (qty <= 0) return { totals: [], discounts: [] };
  const base = Math.floor(lineTotal / qty);
  const rem = lineTotal % qty;
  const totals = Array.from({ length: qty }, (_, i) => base + (i < rem ? 1 : 0));
  return { totals, discounts: totals.map(() => 0) };
}

/**
 * POST /api/orders/checkout
 * Pay from wallet, auto-assign keys, create order(s), mark keys sold.
 */
const checkout = asyncHandler(async (req, res) => {
  const { items, discount_code } = req.body;
  if (!Array.isArray(items) || items.length === 0) throw new AppError('Cart is empty');

  const cart = await computeCart(items, req.user?.role);

  // Pre-check stock before touching the wallet so the common "out of stock"
  // case fails fast without any debit/refund dance.
  await assertStock(cart.lines);

  const discount = await applyDiscount(discount_code, cart.subtotal);
  const total = discount.total;

  // Allocate the discounted total across lines (largest-remainder so the sum
  // of per-line totals is EXACTLY `total`, matching the wallet debit). Each
  // line then splits its discounted total across the claimed keys.
  const lineTotals = allocateLineTotals(cart.lines, cart.subtotal, total);

  // Reserve discount usage BEFORE debiting: if the reservation loses a race
  // with another checkout, we fail before any money moves (no double charge
  // on retry). If the checkout later fails, the reservation is released.
  await reserveDiscount(discount);

  const orderCode = generateOrderCode();
  const createdOrders = [];
  let debited = false;

  try {
    if (total > 0) {
      // ref_id = order_code: the debit is auditable and recoverable. If the
      // process dies AFTER this commit but BEFORE the orders are created, the
      // cron reconcileOrphanedPurchases finds the debit with no matching order
      // and no refund and returns the money (same crash-window recovery as the
      // deposit side). Retrying the same order_code therefore cannot double-
      // debit: debit_wallet is idempotent per (ref_type, ref_id).
      await debitForPurchase({
        userId: req.userId,
        amount: total,
        description: `Thanh toán đơn ${orderCode}`,
        refType: 'order',
        refId: orderCode,
      });
      debited = true;
    }

    for (let i = 0; i < cart.lines.length; i++) {
      const line = cart.lines[i];
      const perKey = allocateKeyTotals(line.qty, lineTotals[i]);
      const orders = await claimKeysBatch({
        userId: req.userId,
        product: line.product,
        variantId: line.variantId,
        variantName: line.variantName,
        qty: line.qty,
        orderCode,
        perKeyTotals: perKey.totals,
        perKeyDiscounts: lineTotals[i] === line.product.price * line.qty
          ? null
          : perKey.totals.map((t) => line.product.price - t),
      });
      createdOrders.push(...orders);
    }
  } catch (err) {
    // Atomic rollback: refund the FULL debited amount, restore all
    // claimed keys, and release the discount reservation. This prevents
    // partial-refund money loss on race with another buyer grabbing the
    // last key(s) mid-checkout.
    if (debited || createdOrders.length > 0) {
      await rollbackCheckout({ userId: req.userId, amount: total, orders: createdOrders, orderCode });
    }
    await releaseDiscount(discount);
    if (err.isOperational && err.statusCode) throw err;
    throw new AppError(err.message || 'Có lỗi xảy ra khi xử lý đơn hàng', 400);
  }

  await logActivity({
    userId: req.userId,
    action: 'order_checkout',
    detail: `${cart.count} items, ${total} VND, code ${orderCode}`,
    ip: req.ip,
  });

  ok(
    res,
    {
      orders: createdOrders.map((o) => ({ id: o.id, order_code: o.order_code, product_name: o.product_name, variant_name: o.variant_name, key_value: o.key_value, price: o.price })),
      total,
      subtotal: cart.subtotal,
      discountAmount: discount.discountAmount,
      orderCode,
    },
    'Thanh toán thành công! Key đã được giao tự động'
  );
});

/**
 * Atomically claim `qty` unsold keys for a product, then create all order
 * rows and notifications in single batched inserts.
 *
 * Strategy: pick `qty` candidate keys, then claim them with ONE atomic
 * UPDATE ... WHERE id IN (...) AND is_sold = false. Concurrent buyers that
 * updated overlapping rows are serialized by Postgres row locks and re-check
 * the WHERE after commit, so the update returns exactly the keys this
 * checkout owns. This turns the old ~4 queries/key into ~4 queries/line.
 */
async function claimKeysBatch({ userId, product, variantId, variantName, qty, orderCode, perKeyTotals, perKeyDiscounts }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: keys, error: selErr } = await admin
      .from('inventory_keys')
      .select('id')
      .eq('product_id', product.id)
      .eq('variant_id', variantId)
      .eq('is_sold', false)
      .order('created_at', { ascending: true })
      .limit(qty);

    if (selErr || !keys || keys.length < qty) {
      throw new AppError(`Loại key "${variantName}" của sản phẩm "${product.name}" đã hết key trong kho`);
    }

    const { data: claimed, error: cErr } = await admin
      .from('inventory_keys')
      .update({ is_sold: true, sold_at: new Date().toISOString() })
      .in('id', keys.map((k) => k.id))
      .eq('is_sold', false)
      .select('id, key_value');

    if (cErr) throw new AppError('Failed to claim keys', 500);

    if (!claimed || claimed.length < qty) {
      // A concurrent checkout grabbed some candidates. Release what we did
      // claim and retry once; if still short, fail (outer rollback refunds).
      if (claimed && claimed.length > 0) {
        await admin
          .from('inventory_keys')
          .update({ is_sold: false, sold_at: null })
          .in('id', claimed.map((k) => k.id));
      }
      if (attempt < 2) continue;
      throw new AppError(`Loại key "${variantName}" của sản phẩm "${product.name}" vừa hết key, vui lòng thử lại`);
    }

    const rows = claimed.map((k, i) => {
      const total = (perKeyTotals && perKeyTotals[i] != null) ? perKeyTotals[i] : product.price;
      const discountAmount = (perKeyDiscounts && perKeyDiscounts[i] != null) ? perKeyDiscounts[i] : 0;
      return {
        order_code: generateOrderCode(),
        user_id: userId,
        product_id: product.id,
        product_name: product.name,
        variant_id: variantId,
        variant_name: variantName,
        price: product.price,
        discount_amount: discountAmount,
        total,
        status: 'success',
        key_id: k.id,
        key_value: k.key_value,
        payment_method: 'wallet',
        group_code: orderCode,
      };
    });

    const { data: orders, error: oErr } = await admin.from('orders').insert(rows).select('*');
    if (oErr) {
      // Release all claimed keys, the order rows never landed.
      await admin
        .from('inventory_keys')
        .update({ is_sold: false, sold_at: null })
        .in('id', claimed.map((k) => k.id));
      throw new AppError('Failed to create orders', 500);
    }

    const notifications = orders.map((o) => ({
      user_id: userId,
      title: 'Giao key thành công',
      content: `Đơn ${o.order_code} - ${product.name}${variantName ? ` (${variantName})` : ''}: ${o.key_value}`,
      type: 'order',
    }));
    await admin.from('notifications').insert(notifications);

    return orders;
  }
  throw new AppError(`Loại key "${variantName}" của sản phẩm "${product.name}" hết key, thử lại sau`);
}

/**
 * Atomically claim one use of a discount code (CAS on used_count).
 * Throws if the code is exhausted.
 */
async function reserveDiscount(discount) {
  if (!discount || !discount.discountId) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: dc } = await admin
      .from('discount_codes')
      .select('used_count, max_uses')
      .eq('id', discount.discountId)
      .single();
    const next = (dc?.used_count || 0) + 1;
    if (dc?.max_uses && next > dc.max_uses) {
      throw new AppError('Mã giảm giá đã hết lượt sử dụng');
    }
    const { data: bumped } = await admin
      .from('discount_codes')
      .update({ used_count: next })
      .eq('id', discount.discountId)
      .eq('used_count', dc?.used_count || 0)
      .select('id')
      .maybeSingle();
    if (bumped) return;
  }
  throw new AppError('Mã giảm giá đã hết lượt sử dụng, thử lại sau');
}

/**
 * Release a previously reserved discount use (rollback path).
 */
async function releaseDiscount(discount) {
  if (!discount || !discount.discountId) return;
  const { data: dc } = await admin
    .from('discount_codes')
    .select('used_count')
    .eq('id', discount.discountId)
    .single();
  if (dc && dc.used_count > 0) {
    await admin
      .from('discount_codes')
      .update({ used_count: dc.used_count - 1 })
      .eq('id', discount.discountId)
      .eq('used_count', dc.used_count);
  }
}

/**
 * Fail fast if any line quantity exceeds remaining stock.
 */
async function assertStock(lines) {
  const productIds = lines.map((l) => l.product.id);
  const { data: keys } = await admin
    .from('inventory_keys')
    .select('product_id, variant_id')
    .eq('is_sold', false)
    .in('product_id', productIds);

  const avail = {};
  (keys || []).forEach((k) => {
    const key = `${k.product_id}:${k.variant_id || ''}`;
    avail[key] = (avail[key] || 0) + 1;
  });

  for (const line of lines) {
    const remaining = avail[`${line.product.id}:${line.variantId}`] || 0;
    if (line.qty > remaining) {
      throw new AppError(`Loại key "${line.variantName}" của sản phẩm "${line.product.name}" chỉ còn ${remaining} key, không đủ số lượng`);
    }
  }
}

/**
 * Full rollback after a failed checkout: refund the ENTIRE debited amount
 * (not just the created orders) and release all claimed keys back to stock.
 */
async function rollbackCheckout({ userId, amount, orders, orderCode }) {
  if (amount > 0) {
    await creditWallet({
      userId,
      amount,
      type: 'refund',
      description: `Hoàn tiền đơn ${orderCode} (không thể hoàn thành do thiếu key)`,
      refType: 'refund',
      refId: orderCode,
    });
  }

  // Release keys that were claimed but the order never completed
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length > 0) {
    const { data: sold } = await admin.from('orders').select('key_id').in('id', orderIds);
    const keyIds = (sold || []).map((o) => o.key_id).filter(Boolean);
    if (keyIds.length > 0) {
      await admin
        .from('inventory_keys')
        .update({ is_sold: false, sold_at: null })
        .in('id', keyIds);
    }
    await admin.from('orders').delete().in('id', orderIds);
  }

  await createNotification({
    userId,
    title: 'Hoàn tiền',
    content: `Đơn ${orderCode} không thể hoàn thành do thiếu key. Đã hoàn ${amount.toLocaleString('vi-VN')}đ về ví.`,
    type: 'refund',
  });
}

/**
 * POST /api/orders/custom - create a pre-order (key not yet in stock),
 * paid from wallet. Shop owner buys keys then completes the order in admin.
 */
const createCustomOrder = asyncHandler(async (req, res) => {
  const { product_id, qty, note, variant_id } = req.body;
  if (!product_id) throw new AppError('product_id is required');
  const numQty = Math.max(1, Math.min(Number(qty) || 1, 50));

  const { data: product, error: pErr } = await admin
    .from('products')
    .select('id, name, price, seller_price, type, image_url, product_variants(id, name, price, seller_price, sort_order)')
    .eq('id', product_id)
    .eq('is_active', true)
    .maybeSingle();
  if (pErr || !product) throw new AppError('Product not found', 404);
  if (product.type !== 'custom') throw new AppError('Sản phẩm này không phải loại đặt hàng');

  // Custom products must also carry a variant (loại key) since it is
  // mandatory; the variant decides the unit price.
  const variants = product.product_variants || [];
  if (!variants.length) throw new AppError('Sản phẩm chưa có loại key, vui lòng liên hệ shop');
  let variant;
  if (variant_id) {
    variant = variants.find((v) => v.id === variant_id);
    if (!variant) throw new AppError('Loại key không hợp lệ');
  } else if (variants.length === 1) {
    variant = variants[0];
  } else {
    throw new AppError('Vui lòng chọn loại key');
  }

  const orderCode = generateOrderCode('DH');
  const unit = variant ? variantPrice(req.user?.role, variant) : buyerPrice(req.user?.role, product);
  const amount = unit * numQty;
  await debitForPurchase({
    userId: req.userId,
    amount,
    description: `Đặt hàng ${orderCode} - ${product.name}${variant.name ? ` (${variant.name})` : ''} x${numQty}`,
    refType: 'custom_order',
    refId: orderCode,
  });

  const { data: order, error: oErr } = await admin
    .from('custom_orders')
    .insert({
      order_code: orderCode,
      user_id: req.userId,
      product_id,
      product_name: product.name,
      variant_id: variant?.id || null,
      variant_name: variant?.name || null,
      qty: numQty,
      note: note || '',
      status: 'pending',
      paid_amount: amount,
    })
    .select('*')
    .single();

  if (oErr) {
    await refundCustomOrder(req.userId, amount, orderCode);
    throw new AppError('Failed to create custom order', 500);
  }

  await logActivity({
    userId: req.userId,
    action: 'custom_order_create',
    detail: `${orderCode} - ${product.name} x${numQty}`,
    ip: req.ip,
  });

  ok(res, order, 'Đơn đặt mua trước đã được tạo, vui lòng chờ admin giao key');
});

async function refundCustomOrder(userId, amount, orderCode) {
  await creditWallet({
    userId,
    amount,
    type: 'refund',
    description: `Hoàn tiền đơn đặt ${orderCode}`,
    refType: 'refund',
    refId: orderCode,
  });
}

module.exports = { orderController: { myOrders, detail, checkout, createCustomOrder, previewCart } };
