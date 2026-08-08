const { admin } = require('../config/supabase');
const { ok } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

/**
 * GET /api/categories - active categories (with active product counts),
 * ordered by sort_order then name.
 */
const list = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new AppError('Failed to fetch categories', 500);

  const ids = (data || []).map((c) => c.id);
  let counts = {};
  if (ids.length > 0) {
    const { data: products } = await admin
      .from('products')
      .select('category_id')
      .eq('is_active', true)
      .in('category_id', ids);
    (products || []).forEach((p) => {
      counts[p.category_id] = (counts[p.category_id] || 0) + 1;
    });
  }

  const out = (data || []).map((c) => ({ ...c, product_count: counts[c.id] || 0 }));
  ok(res, out);
});

module.exports = { categoryController: { list } };
