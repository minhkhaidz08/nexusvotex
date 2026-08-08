const { admin } = require('../config/supabase');
const { ok, generateOrderCode, sanitizeLimit, sanitizePage, sanitizeSearch, slugify } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { createNotification, logActivity } = require('../services/notification.service');
const { adjustBalance, creditWallet } = require('../services/wallet.service');

/* ============ DASHBOARD ============ */
const dashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // Revenue is computed from wallet_transactions, NOT orders.total:
  //  - orders.total stores the undiscounted line price, so summing it would
  //    overstate revenue whenever a discount code is used.
  //  - custom-order payments also live in wallet_transactions as 'purchase'.
  //  - signed sum (purchase=negative, refund=positive) gives net money in.
  const [revToday, revMonth, orders, customOrders, users, keysLeft, pendingOrders, depositsToday] =
    await Promise.all([
      admin.from('wallet_transactions').select('amount').in('type', ['purchase', 'refund']).gte('created_at', todayStart),
      admin.from('wallet_transactions').select('amount').in('type', ['purchase', 'refund']).gte('created_at', monthStart),
      admin.from('orders').select('id', { count: 'exact', head: true }),
      admin.from('custom_orders').select('id', { count: 'exact', head: true }),
      admin.from('users').select('id', { count: 'exact', head: true }),
      admin.from('inventory_keys').select('id', { count: 'exact', head: true }).eq('is_sold', false),
      admin.from('custom_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('payments').select('amount').eq('status', 'success').gte('created_at', todayStart),
    ]);

  const netRevenue = (rows) => -(rows || []).reduce((s, o) => s + Number(o.amount), 0);

  ok(res, {
    revenue_today: netRevenue(revToday.data),
    revenue_month: netRevenue(revMonth.data),
    deposit_today: (depositsToday.data || []).reduce((s, o) => s + Number(o.amount), 0),
    order_count: orders.count || 0,
    custom_order_count: customOrders.count || 0,
    user_count: users.count || 0,
    keys_left: keysLeft.count || 0,
    pending_orders: pendingOrders.count || 0,
  });
});

/* ============ PRODUCTS ============ */

/**
 * Validate and normalize the `variants` (loại key) array. Every product must
 * declare at least one variant, each with its own name, price and optional
 * seller_price. Returns [{ id?, name, price, seller_price, sort_order }].
 */
function parseVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new AppError('Vui lòng khai báo ít nhất 1 loại key (biến thể)');
  }
  return variants.map((v, i) => {
    const name = String(v?.name || '').trim();
    if (!name) throw new AppError(`Tên loại key #${i + 1} không được để trống`);
    const price = Number(v?.price);
    if (!(price > 0)) throw new AppError(`Giá loại key "${name}" phải là số dương`);
    const seller_price =
      v?.seller_price === '' || v?.seller_price === null || v?.seller_price === undefined
        ? null
        : Number(v.seller_price);
    if (seller_price !== null && !(seller_price >= 0)) {
      throw new AppError(`Giá seller loại key "${name}" phải là số không âm`);
    }
    return {
      id: v?.id || null,
      name,
      price,
      seller_price,
      sort_order: i,
    };
  });
}

const listProducts = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('products')
    .select('*, product_variants(*)')
    .order('created_at', { ascending: false });
  if (error) throw new AppError('Failed to fetch products', 500);

  // attach stock counts
  const ids = data.map((p) => p.id);
  const { data: keys } = await admin
    .from('inventory_keys')
    .select('product_id')
    .eq('is_sold', false)
    .in('product_id', ids);
  const map = {};
  (keys || []).forEach((k) => (map[k.product_id] = (map[k.product_id] || 0) + 1));

  const out = data.map((p) => {
    const { product_variants, ...rest } = p;
    return {
      ...rest,
      variants: (product_variants || []).map((v) => ({
        id: v.id,
        name: v.name,
        price: Number(v.price),
        seller_price: v.seller_price != null ? Number(v.seller_price) : null,
        sort_order: v.sort_order,
      })),
      stock: p.stock_override !== null ? p.stock_override : map[p.id] || 0,
    };
  });
  ok(res, out);
});

const createProduct = asyncHandler(async (req, res) => {
  const { name, price, seller_price, category, type, description, short_description, image_url, badge, is_active, is_featured, is_hot, is_sale, stock_override, discount, original_price } = req.body;

  if (!name || !type) throw new AppError('name and type are required');
  if (!['instant', 'custom'].includes(type)) throw new AppError('type must be instant or custom');

  // Every product must have at least one variant (loại key). Each variant
  // carries its own price; the product-level price is only a fallback.
  const variants = parseVariants(req.body.variants);

  // Product-level price is optional - when omitted it falls back to the
  // cheapest variant so list/display code keeps a meaningful number. An
  // explicitly provided negative/zero price is still rejected.
  let numPrice = variants.length ? Math.min(...variants.map((v) => v.price)) : 0;
  if (price !== undefined && price !== '' && price !== null) {
    numPrice = Number(price);
    if (!(numPrice > 0)) throw new AppError('price must be a positive number');
  }
  const numSellerPrice = seller_price === '' || seller_price === null || seller_price === undefined
    ? null
    : Number(seller_price);
  if (numSellerPrice !== null && !(numSellerPrice >= 0)) throw new AppError('seller_price must be a non-negative number');

  let slug = slugify(name);

  const { data: existing } = await admin.from('products').select('id').eq('slug', slug).maybeSingle();
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  // Optional category association: sync the text `category` field to the
  // category name so existing display/filter code keeps working.
  let catName = (category || '').trim() || 'Khác';
  let catId = null;
  if (req.body.category_id) {
    const { data: cat } = await admin.from('categories').select('id, name').eq('id', req.body.category_id).maybeSingle();
    if (!cat) throw new AppError('Danh mục không tồn tại', 400);
    catId = cat.id;
    catName = cat.name;
  }

  const { data, error } = await admin
    .from('products')
    .insert({
      name,
      slug,
      price: numPrice,
      seller_price: numSellerPrice,
      original_price: original_price ? Number(original_price) : null,
      category: catName,
      category_id: catId,
      type,
      description: description || '',
      short_description: short_description || '',
      image_url: image_url || null,
      badge: badge || null,
      is_active: is_active !== false,
      is_featured: !!is_featured,
      is_hot: !!is_hot,
      is_sale: !!is_sale,
      discount: discount ? Number(discount) : null,
      stock_override: stock_override === '' || stock_override === null ? null : Number(stock_override),
    })
    .select('*')
    .single();
  if (error) throw new AppError('Failed to create product', 500);

  const { data: variantsData, error: vErr } = await admin
    .from('product_variants')
    .insert(variants.map((v) => ({ product_id: data.id, name: v.name, price: v.price, seller_price: v.seller_price, sort_order: v.sort_order })));
  if (vErr) throw new AppError('Failed to create product variants', 500);

  data.variants = variantsData || [];

  await logActivity({ userId: req.userId, action: 'product_create', detail: name, ip: req.ip });
  ok(res, data, 'Đã tạo sản phẩm');
});

const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const allowed = ['name', 'price', 'seller_price', 'original_price', 'category', 'type', 'description', 'short_description', 'image_url', 'badge', 'is_active', 'is_featured', 'is_hot', 'is_sale', 'discount', 'stock_override', 'sort_order'];

  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (patch.price !== undefined) {
    patch.price = Number(patch.price);
    if (!(patch.price > 0)) throw new AppError('price must be a positive number', 400);
  }
  if (patch.seller_price !== undefined) {
    patch.seller_price = patch.seller_price === '' ? null : Number(patch.seller_price);
    if (patch.seller_price !== null && !(patch.seller_price >= 0)) throw new AppError('seller_price must be a non-negative number', 400);
  }
  if (patch.discount !== undefined) patch.discount = patch.discount === '' ? null : Number(patch.discount);
  if (patch.stock_override !== undefined) {
    patch.stock_override = patch.stock_override === '' ? null : Number(patch.stock_override);
  }

  // If replacing image_url, safely auto-delete the old product image from storage
  if (patch.image_url !== undefined) {
    try {
      const { data: oldProd } = await admin.from('products').select('image_url').eq('id', id).maybeSingle();
      if (oldProd?.image_url && oldProd.image_url !== patch.image_url) {
        await deleteStorageFile(oldProd.image_url);
      }
    } catch (err) {
      console.warn('[updateProduct] Storage cleanup notice:', err?.message || err);
    }
  }

  // category_id association: ''/null clears it, a uuid must exist.
  // When set, the text `category` is re-synced from the category name.
  if (req.body.category_id !== undefined) {
    if (req.body.category_id === '' || req.body.category_id === null) {
      patch.category_id = null;
      if (req.body.category === undefined) patch.category = 'Khác';
    } else {
      const { data: cat } = await admin.from('categories').select('id, name').eq('id', req.body.category_id).maybeSingle();
      if (!cat) throw new AppError('Danh mục không tồn tại', 400);
      patch.category_id = cat.id;
      patch.category = cat.name;
    }
  }

  // Replace the variant set when provided. Existing variants keep their ids
  // (so their stock keys survive a rename); removed variants are deleted
  // (their keys cascade-delete with them); new ones are inserted.
  if (req.body.variants !== undefined) {
    const { data: existing } = await admin
      .from('products')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) throw new AppError('Không tìm thấy sản phẩm', 404);

    const variants = parseVariants(req.body.variants);
    if (patch.price === undefined && variants.length) {
      patch.price = Math.min(...variants.map((v) => v.price));
    }

    const { data: currentVariants } = await admin
      .from('product_variants')
      .select('id')
      .eq('product_id', id);

    const incomingIds = variants.map((v) => v.id).filter(Boolean);
    const removedIds = (currentVariants || [])
      .filter((v) => !incomingIds.includes(v.id))
      .map((v) => v.id);

    if (removedIds.length > 0) {
      const { error: delErr } = await admin.from('product_variants').delete().in('id', removedIds);
      if (delErr) {
        console.error('[updateProduct] Error deleting old variants:', delErr);
      }
    }

    for (const v of variants) {
      const row = { name: v.name, price: v.price, seller_price: v.seller_price, sort_order: v.sort_order };
      if (v.id) {
        const { error: upErr } = await admin.from('product_variants').update(row).eq('id', v.id);
        if (upErr) {
          console.error('[updateProduct] Error updating variant:', upErr);
          throw new AppError(`Không thể cập nhật loại key "${v.name}": ${upErr.message}`, 400);
        }
      } else {
        const { error: inErr } = await admin.from('product_variants').insert({ product_id: id, ...row });
        if (inErr) {
          console.error('[updateProduct] Error inserting variant:', inErr);
          throw new AppError(`Không thể thêm loại key "${v.name}": ${inErr.message}`, 400);
        }
      }
    }
  }

  const { data, error } = await admin
    .from('products')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    console.error('[updateProduct] Error updating product:', error);
    throw new AppError(`Không thể cập nhật sản phẩm: ${error.message}`, 400);
  }

  await logActivity({ userId: req.userId, action: 'product_update', detail: data.name, ip: req.ip });
  ok(res, data, 'Đã cập nhật sản phẩm');
});

const deleteProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data: product } = await admin.from('products').select('name, image_url').eq('id', id).maybeSingle();
  if (!product) throw new AppError('Không tìm thấy sản phẩm', 404);

  // Orders, custom orders and sold keys FK-reference the product (no cascade),
  // so a product with purchase history cannot be hard-deleted.
  const { count: orders } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('product_id', id);
  const { count: customs } = await admin.from('custom_orders').select('id', { count: 'exact', head: true }).eq('product_id', id);
  if ((orders || 0) > 0 || (customs || 0) > 0) {
    throw new AppError('Không thể xóa sản phẩm đã có đơn hàng — hãy ẩn nó thay vì xóa', 400);
  }

  // Unsold keys and variants cascade-delete with the product.
  const { error } = await admin.from('products').delete().eq('id', id);
  if (error) throw new AppError('Không thể xóa sản phẩm', 500);

  if (product.image_url) {
    await deleteStorageFile(product.image_url);
  }

  await logActivity({ userId: req.userId, action: 'product_delete', detail: product.name, ip: req.ip });
  ok(res, null, 'Đã xóa sản phẩm');
});

/* ============ CATEGORIES ============ */
const listCategories = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('categories')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new AppError('Failed to fetch categories', 500);

  const ids = (data || []).map((c) => c.id);
  let counts = {};
  if (ids.length > 0) {
    const { data: products } = await admin.from('products').select('category_id').in('category_id', ids);
    (products || []).forEach((p) => (counts[p.category_id] = (counts[p.category_id] || 0) + 1));
  }
  ok(res, (data || []).map((c) => ({ ...c, product_count: counts[c.id] || 0 })));
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, icon, description, sort_order } = req.body;
  if (!name) throw new AppError('Tên danh mục là bắt buộc');

  let slug = slugify(name);
  const { data: existing } = await admin.from('categories').select('id').eq('slug', slug).maybeSingle();
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  const { data, error } = await admin
    .from('categories')
    .insert({
      name: String(name).trim(),
      slug,
      icon: icon || '',
      description: description || '',
      sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
      is_active: true,
    })
    .select('*')
    .single();
  if (error) throw new AppError('Failed to create category', 500);

  await logActivity({ userId: req.userId, action: 'category_create', detail: data.name, ip: req.ip });
  ok(res, data, 'Đã tạo danh mục');
});

const updateCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const allowed = ['name', 'icon', 'description', 'sort_order', 'is_active'];
  const patch = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  if (patch.name !== undefined) patch.name = String(patch.name).trim();
  if (patch.sort_order !== undefined) patch.sort_order = Number(patch.sort_order) || 0;
  if (patch.is_active !== undefined) patch.is_active = !!patch.is_active;

  const { data: cat, error: cErr } = await admin.from('categories').select('name').eq('id', id).maybeSingle();
  if (cErr || !cat) throw new AppError('Category not found', 404);

  const { data, error } = await admin.from('categories').update(patch).eq('id', id).select('*').single();
  if (error) throw new AppError('Failed to update category', 500);

  // Renaming syncs the denormalized text `category` on assigned products.
  if (patch.name && patch.name !== cat.name) {
    await admin.from('products').update({ category: patch.name }).eq('category_id', id);
  }

  await logActivity({ userId: req.userId, action: 'category_update', detail: data.name, ip: req.ip });
  ok(res, data, 'Đã cập nhật danh mục');
});

const deleteCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data: cat, error: cErr } = await admin.from('categories').select('name').eq('id', id).maybeSingle();
  if (cErr || !cat) throw new AppError('Category not found', 404);

  // Reassign products to the default "Khác" so nothing is orphaned.
  await admin.from('products').update({ category_id: null, category: 'Khác' }).eq('category_id', id);

  const { error } = await admin.from('categories').delete().eq('id', id);
  if (error) throw new AppError('Failed to delete category', 500);

  await logActivity({ userId: req.userId, action: 'category_delete', detail: cat.name, ip: req.ip });
  ok(res, null, 'Đã xóa danh mục');
});

/* ============ INVENTORY ============ */
const listInventory = asyncHandler(async (req, res) => {
  const { product_id } = req.query;
  const page = sanitizePage(req.query.page);
  const pageSize = sanitizeLimit(req.query.pageSize, 50, 500);
  let query = admin
    .from('inventory_keys')
    .select('*, products(name), product_variants(name)')
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (product_id) query = query.eq('product_id', product_id);
  query = query.eq('is_sold', false);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch inventory', 500);
  ok(res, data || []);
});

const listSoldKeys = asyncHandler(async (req, res) => {
  const { product_id } = req.query;
  const limit = sanitizeLimit(req.query.limit, 100, 500);
  let query = admin
    .from('inventory_keys')
    .select('*, orders(order_code, user_id, users(email, name))')
    .eq('is_sold', true)
    .order('sold_at', { ascending: false })
    .limit(limit);
  if (product_id) query = query.eq('product_id', product_id);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch sold keys', 500);
  ok(res, data || []);
});

const addKey = asyncHandler(async (req, res) => {
  const { product_id, variant_id, key_value } = req.body;
  if (!product_id || !key_value) throw new AppError('product_id and key_value are required');
  if (!variant_id) throw new AppError('Vui lòng chọn loại key (biến thể) cho key này');

  const { data: vCheck, error: vErr } = await admin
    .from('product_variants')
    .select('id')
    .eq('id', variant_id)
    .eq('product_id', product_id)
    .maybeSingle();
  if (vErr || !vCheck) throw new AppError('Loại key (biến thể) không thuộc sản phẩm này', 400);

  const keys = String(key_value)
    .split(/[\r\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);

  if (keys.length === 0) throw new AppError('No valid keys provided');

  const rows = keys.map((k) => ({ product_id, variant_id, key_value: k, is_sold: false }));
  const { data, error } = await admin.from('inventory_keys').insert(rows).select('*');
  if (error) throw new AppError('Failed to add keys', 500);

  await logActivity({ userId: req.userId, action: 'inventory_add', detail: `${keys.length} keys`, ip: req.ip });
  ok(res, data, `Đã thêm ${keys.length} key`);
});

const updateKey = asyncHandler(async (req, res) => {
  const { key_value, variant_id } = req.body;
  const patch = {};
  if (key_value !== undefined) patch.key_value = key_value;
  if (variant_id !== undefined) patch.variant_id = variant_id;
  if (Object.keys(patch).length === 0) throw new AppError('Nothing to update');

  const { data, error } = await admin
    .from('inventory_keys')
    .update(patch)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) throw new AppError('Failed to update key', 500);
  ok(res, data, 'Đã cập nhật key');
});

const deleteKey = asyncHandler(async (req, res) => {
  const { data: key } = await admin.from('inventory_keys').select('is_sold').eq('id', req.params.id).maybeSingle();
  if (!key) throw new AppError('Key not found', 404);
  if (key.is_sold) {
    // Sold keys are FK-referenced by orders; hard-deleting breaks history.
    throw new AppError('Không thể xóa key đã bán', 400);
  }

  const { error } = await admin.from('inventory_keys').delete().eq('id', req.params.id);
  if (error) throw new AppError('Failed to delete key', 500);
  ok(res, null, 'Đã xóa key');
});

const importKeys = asyncHandler(async (req, res) => {
  const { product_id, variant_id, content, format = 'txt' } = req.body;
  if (!product_id || !content) throw new AppError('product_id and content are required');
  if (!variant_id) throw new AppError('Vui lòng chọn loại key (biến thể) cho key nhập vào');

  const { data: vCheck, error: vErr } = await admin
    .from('product_variants')
    .select('id')
    .eq('id', variant_id)
    .eq('product_id', product_id)
    .maybeSingle();
  if (vErr || !vCheck) throw new AppError('Loại key (biến thể) không thuộc sản phẩm này', 400);

  let keys = [];
  if (format === 'txt') {
    keys = String(content).split(/\r?\n/);
  } else if (format === 'csv') {
    const lines = String(content).split(/\r?\n/);
    keys = lines.map((line) => line.split(',')[0]);
  } else {
    throw new AppError('format must be txt or csv');
  }

  keys = keys.map((k) => k.trim()).filter(Boolean);

  if (keys.length === 0) throw new AppError('No keys found in file');

  const { data, error } = await admin.from('inventory_keys').insert(
    keys.map((k) => ({ product_id, variant_id, key_value: k, is_sold: false }))
  );
  if (error) throw new AppError('Failed to import keys', 500);

  await logActivity({ userId: req.userId, action: 'inventory_import', detail: `${keys.length} keys`, ip: req.ip });
  ok(res, { imported: keys.length }, `Đã import ${keys.length} key`);
});

/* ============ ORDERS ============ */
const listOrders = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const limit = sanitizeLimit(req.query.limit, 100, 500);
  let query = admin
    .from('orders')
    .select('*, users(email, name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch orders', 500);
  ok(res, data || []);
});

const orderDetail = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('orders')
    .select('*, users(email, name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error || !data) throw new AppError('Order not found', 404);
  ok(res, data);
});

/* ============ CUSTOM ORDERS ============ */
const listCustomOrders = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const limit = sanitizeLimit(req.query.limit, 100, 500);
  let query = admin
    .from('custom_orders')
    .select('*, users(email, name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch custom orders', 500);
  ok(res, data || []);
});

const completeCustomOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { key_value, admin_message } = req.body;

  if (!key_value && !admin_message) {
    throw new AppError('Vui lòng nhập key hoặc lời nhắn cho khách');
  }

  const { data: order, error } = await admin
    .from('custom_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !order) throw new AppError('Custom order not found', 404);
  // Only pending orders can be completed. A cancelled order has already been
  // refunded - completing it would hand the customer both the refund AND the key.
  if (order.status !== 'pending') throw new AppError('Chỉ có thể hoàn thành đơn đang chờ xử lý');

  const payload = {
    status: 'completed',
    completed_at: new Date().toISOString(),
    admin_key: key_value || order.admin_key || null,
    admin_message: admin_message || '',
  };

  const { data: updated, error: uErr } = await admin
    .from('custom_orders')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();
  if (uErr) throw new AppError('Failed to complete custom order', 500);

  await createNotification({
    userId: order.user_id,
    title: 'Đơn đặt mua đã có key!',
    content: `Đơn ${order.order_code} - ${order.product_name} đã hoàn thành. Key đã được gửi, xem trong Lịch sử.${admin_message ? ` Ghi chú: ${admin_message}` : ''}`,
    type: 'custom_order',
  });

  await logActivity({ userId: req.userId, action: 'custom_order_complete', detail: order.order_code, ip: req.ip });
  ok(res, updated, 'Đã giao key, khách hàng sẽ nhận được thông báo');
});

const cancelCustomOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason = '' } = req.body;

  const { data: order, error } = await admin
    .from('custom_orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !order) throw new AppError('Custom order not found', 404);
  if (order.status !== 'pending') throw new AppError('Chỉ có thể hủy đơn đang chờ xử lý');

  // CAS transition pending -> cancelled: only one concurrent cancel can win,
  // so the refund below cannot be applied twice.
  const { data: claimed, error: claimErr } = await admin
    .from('custom_orders')
    .update({ status: 'cancelled', admin_message: reason || 'Đã hủy bởi admin' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimErr || !claimed) throw new AppError('Đơn đã được xử lý trước đó', 400);

  // Refund
  await creditWallet({
    userId: order.user_id,
    amount: order.paid_amount,
    type: 'refund',
    description: `Hoàn tiền hủy đơn ${order.order_code}`,
    refType: 'custom_order',
    refId: order.id,
  });

  await createNotification({
    userId: order.user_id,
    title: 'Đơn đặt hàng đã hủy',
    content: `Đơn ${order.order_code} - ${order.product_name} đã bị hủy. Số tiền ${Number(order.paid_amount).toLocaleString('vi-VN')}đ đã được hoàn về ví.`,
    type: 'refund',
  });

  await logActivity({ userId: req.userId, action: 'custom_order_cancel', detail: order.order_code, ip: req.ip });
  ok(res, null, 'Đã hủy đơn và hoàn tiền cho khách');
});

/* ============ USERS ============ */
const listUsers = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const page = sanitizePage(req.query.page);
  const pageSize = sanitizeLimit(req.query.pageSize, 50, 500);
  let query = admin
    .from('users')
    .select('id, email, name, avatar_url, role, is_banned, created_at, wallets(balance)')
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (search) {
    const safe = sanitizeSearch(search);
    if (safe) query = query.or(`email.ilike.%${safe}%,name.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch users', 500);
  ok(res, data || []);
});

const updateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const patch = {};
  if (req.body.is_banned !== undefined) patch.is_banned = !!req.body.is_banned;
  if (req.body.role !== undefined) {
    const allowedRoles = ['user', 'admin', 'seller'];
    patch.role = allowedRoles.includes(req.body.role) ? req.body.role : 'user';
  }
  if (req.body.name !== undefined) patch.name = req.body.name;

  // Prevent an admin from demoting themselves (self lockout).
  if (id === req.userId && patch.role !== undefined && patch.role !== 'admin') {
    throw new AppError('Không thể tự hạ quyền quản trị của chính mình', 400);
  }

  const { data, error } = await admin.from('users').update(patch).eq('id', id).select('id, email, name, role, is_banned').single();
  if (error) throw new AppError('Failed to update user', 500);

  await logActivity({ userId: req.userId, action: 'user_update', detail: `${data.email} ${JSON.stringify(patch)}`, ip: req.ip });
  ok(res, data, 'Đã cập nhật người dùng');
});

const adjustUserBalance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount, note } = req.body;
  const num = Number(amount);
  if (!num || num === 0) throw new AppError('amount must be a non-zero number');

  const newBalance = await adjustBalance({
    userId: id,
    amount: num,
    description: note || `Điều chỉnh bởi admin (${req.user.name})`,
    type: num > 0 ? 'adjust_credit' : 'adjust_debit',
    actorId: req.userId,
  });

  ok(res, { new_balance: newBalance }, `Đã ${num > 0 ? 'cộng' : 'trừ'} ${Math.abs(num).toLocaleString('vi-VN')}đ`);
});

const userTransactions = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('wallet_transactions')
    .select('*')
  .eq('user_id', req.params.id)
  .order('created_at', { ascending: false })
  .limit(200);
  if (error) throw new AppError('Failed to fetch transactions', 500);
  ok(res, data || []);
});

/* ============ DISCOUNT CODES ============ */
const listDiscounts = asyncHandler(async (req, res) => {
  const { data, error } = await admin.from('discount_codes').select('*').order('created_at', { ascending: false });
  if (error) throw new AppError('Failed to fetch discount codes', 500);
  ok(res, data || []);
});

const createDiscount = asyncHandler(async (req, res) => {
  const { code, discount_type, value, max_uses, min_amount, expires_at } = req.body;
  if (!code || !discount_type || !value) throw new AppError('code, discount_type and value are required');
  if (!['percent', 'fixed'].includes(discount_type)) throw new AppError('discount_type must be percent or fixed');
  if (discount_type === 'percent' && (Number(value) <= 0 || Number(value) > 100)) {
    throw new AppError('Percent value must be 1-100');
  }

  const { data, error } = await admin
    .from('discount_codes')
    .insert({
      code: String(code).trim().toUpperCase(),
      discount_type,
      value: Number(value),
      max_uses: max_uses ? Number(max_uses) : null,
      min_amount: min_amount ? Number(min_amount) : null,
      expires_at: expires_at || null,
      is_active: true,
      used_count: 0,
    })
    .select('*')
    .single();
  if (error) throw new AppError('Failed to create discount code', 500);
  ok(res, data, 'Đã tạo mã giảm giá');
});

const updateDiscount = asyncHandler(async (req, res) => {
  const allowed = ['code', 'discount_type', 'value', 'max_uses', 'min_amount', 'expires_at', 'is_active'];
  const patch = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });

  if (patch.discount_type !== undefined && !['percent', 'fixed'].includes(patch.discount_type)) {
    throw new AppError('discount_type must be percent or fixed');
  }
  if (patch.value !== undefined) {
    patch.value = Number(patch.value);
    if (!Number.isFinite(patch.value)) throw new AppError('value must be a number');
    if (patch.discount_type === 'percent' && (patch.value <= 0 || patch.value > 100)) {
      throw new AppError('Percent value must be 1-100');
    }
  }

  const { data, error } = await admin.from('discount_codes').update(patch).eq('id', req.params.id).select('*').single();
  if (error) throw new AppError('Failed to update discount code', 500);
  ok(res, data, 'Đã cập nhật mã giảm giá');
});

const deleteDiscount = asyncHandler(async (req, res) => {
  const { error } = await admin.from('discount_codes').delete().eq('id', req.params.id);
  if (error) throw new AppError('Failed to delete discount code', 500);
  ok(res, null, 'Đã xóa mã giảm giá');
});

/* ============ NEWS ============ */
const listNews = asyncHandler(async (req, res) => {
  const { data, error } = await admin.from('news').select('*').order('created_at', { ascending: false });
  if (error) throw new AppError('Failed to fetch news', 500);
  ok(res, data || []);
});

const createNews = asyncHandler(async (req, res) => {
  const { title, content, image_url, is_published } = req.body;
  if (!title || !content) throw new AppError('title and content are required');

  const { data, error } = await admin
    .from('news')
    .insert({ title, content, image_url: image_url || null, is_published: is_published !== false })
    .select('*')
    .single();
  if (error) throw new AppError('Failed to create news', 500);

  if (data.is_published) {
    await createNotification({
      userId: null,
      title: `Tin mới: ${data.title}`,
      content: data.content.slice(0, 100),
      type: 'news',
    });
  }

  ok(res, data, 'Đã đăng tin tức');
});

const updateNews = asyncHandler(async (req, res) => {
  const allowed = ['title', 'content', 'image_url', 'is_published'];
  const patch = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  const { data, error } = await admin.from('news').update(patch).eq('id', req.params.id).select('*').single();
  if (error) throw new AppError('Failed to update news', 500);
  ok(res, data, 'Đã cập nhật tin tức');
});

const deleteNews = asyncHandler(async (req, res) => {
  const { error } = await admin.from('news').delete().eq('id', req.params.id);
  if (error) throw new AppError('Failed to delete news', 500);
  ok(res, null, 'Đã xóa tin tức');
});

/* ============ SETTINGS ============ */
const getSettings = asyncHandler(async (req, res) => {
  const { data, error } = await admin.from('settings').select('*');
  if (error) throw new AppError('Failed to fetch settings', 500);
  const map = {};
  (data || []).forEach((s) => (map[s.key] = s.value));
  ok(res, map);
});

const updateSettings = asyncHandler(async (req, res) => {
  const allowed = ['logo_url', 'banner_url', 'shop_name', 'slogan', 'facebook', 'discord', 'telegram', 'zalo', 'contact_cards', 'email', 'phone', 'notifications_enabled', 'main_color', 'background_color', 'announcement', 'address', 'terms', 'privacy_policy', 'payment_guide', 'maintenance_deposit_card', 'maintenance_deposit_bank', 'guide_cards'];

  const entries = Object.entries(req.body).filter(([k]) => allowed.includes(k));

  for (const [key, value] of entries) {
    const existing = await admin.from('settings').select('id').eq('key', key).maybeSingle();
    if (existing.data) {
      await admin.from('settings').update({ value }).eq('key', key);
    } else {
      await admin.from('settings').insert({ key, value });
    }
  }

  await logActivity({ userId: req.userId, action: 'settings_update', detail: `${entries.length} keys`, ip: req.ip });
  ok(res, null, 'Đã lưu cài đặt');
});

/* ============ ACTIVITY LOGS ============ */
const listActivityLogs = asyncHandler(async (req, res) => {
  const limit = sanitizeLimit(req.query.limit, 100, 500);
  const { data, error } = await admin
    .from('activity_logs')
    .select('*, users(email, name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new AppError('Failed to fetch activity logs', 500);
  ok(res, data || []);
});

module.exports = { adminController: {
  dashboard,
  listProducts, createProduct, updateProduct, deleteProduct,
  listCategories, createCategory, updateCategory, deleteCategory,
  listInventory, listSoldKeys, addKey, updateKey, deleteKey, importKeys,
  listOrders, orderDetail,
  listCustomOrders, completeCustomOrder, cancelCustomOrder,
  listUsers, updateUser, adjustUserBalance, userTransactions,
  listDiscounts, createDiscount, updateDiscount, deleteDiscount,
  listNews, createNews, updateNews, deleteNews,
  getSettings, updateSettings,
  listActivityLogs,
} };
