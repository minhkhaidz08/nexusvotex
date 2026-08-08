const { admin } = require('../config/supabase');
const { ok, sanitizeLimit } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

const LIST_COLS =
  'id, name, slug, description, short_description, price, seller_price, original_price, category, category_id, type, image_url, badge, is_active, is_featured, is_hot, is_sale, stock_override, discount, created_at, product_variants(id, name, price, seller_price, sort_order)';

const list = asyncHandler(async (req, res) => {
  const { category, category_id, type, search } = req.query;
  const limit = sanitizeLimit(req.query.limit, 100, 200);

  let query = admin
    .from('products')
    .select(LIST_COLS)
    .eq('is_active', true)
    .order('is_featured', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (category) query = query.eq('category', category);
  if (category_id) query = query.eq('category_id', category_id);
  if (type) query = query.eq('type', type);
  if (search) query = query.ilike('name', `%${search}%`);

  const { data, error } = await query;
  if (error) throw new AppError('Failed to fetch products', 500);

  const enriched = await enrichStock(data);
  ok(res, enriched);
});

const featured = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('products')
    .select(LIST_COLS)
    .eq('is_active', true)
    .eq('is_featured', true)
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) throw new AppError('Failed to fetch featured products', 500);

  ok(res, await enrichStock(data));
});

const detail = asyncHandler(async (req, res) => {
  const { id } = req.params;

  let query = admin.from('products').select(LIST_COLS);

  const byUuid = /^[0-9a-f-]{36}$/i.test(id);
  query = byUuid ? query.eq('id', id) : query.eq('slug', id);

  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new AppError('Product not found', 404);
  if (!data.is_active) throw new AppError('Product not found', 404);

  const enriched = await enrichStock([data]);
  ok(res, enriched[0]);
});

/**
 * Compute remaining stock for each product from inventory_keys, plus
 * per-variant stock. Products carry their variants as `variants` (renamed
 * from the embedded `product_variants` relation).
 */
async function enrichStock(products) {
  if (!products || products.length === 0) return [];

  const productIds = products.map((p) => p.id);
  const { data: counts } = await admin
    .from('inventory_keys')
    .select('product_id, variant_id')
    .eq('is_sold', false)
    .in('product_id', productIds);

  const countMap = {};
  const variantCount = {};
  (counts || []).forEach((row) => {
    countMap[row.product_id] = (countMap[row.product_id] || 0) + 1;
    if (row.variant_id) variantCount[row.variant_id] = (variantCount[row.variant_id] || 0) + 1;
  });

  return products.map((p) => {
    // Manual stock override only applies when it's a positive number. When it's
    // 0, null or empty, always fall back to counting real unsold keys so that
    // entering keys in the admin actually moves the displayed stock.
    const remaining =
      p.stock_override > 0
        ? p.stock_override
        : countMap[p.id] || 0;
    const variants = (p.product_variants || []).map((v) => ({
      id: v.id,
      name: v.name,
      price: Number(v.price),
      seller_price: v.seller_price != null ? Number(v.seller_price) : null,
      sort_order: v.sort_order,
      stock: variantCount[v.id] || 0,
    }));
    const { product_variants, ...rest } = p;
    return { ...rest, variants, stock: remaining };
  });
}

module.exports = { productController: { list, featured, detail } };
