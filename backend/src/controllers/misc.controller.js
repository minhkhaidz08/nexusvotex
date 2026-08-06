const { admin } = require('../config/supabase');
const { ok } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

const listNews = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('news')
    .select('id, title, content, image_url, created_at')
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new AppError('Failed to fetch news', 500);
  ok(res, data || []);
});

const newsDetail = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('news')
    .select('*')
    .eq('id', req.params.id)
    .eq('is_published', true)
    .maybeSingle();
  if (error || !data) throw new AppError('News not found', 404);
  ok(res, data);
});

const PUBLIC_SETTINGS = ['logo_url', 'banner_url', 'shop_name', 'slogan', 'facebook', 'discord', 'telegram', 'zalo', 'contact_cards', 'email', 'notifications_enabled', 'main_color', 'background_color', 'announcement', 'maintenance_deposit_card', 'maintenance_deposit_bank', 'terms', 'privacy_policy', 'payment_guide', 'guide_cards'];

const publicSettings = asyncHandler(async (req, res) => {
  const { data, error } = await admin
    .from('settings')
    .select('key, value');
  if (error) throw new AppError('Failed to fetch settings', 500);

  const map = {};
  (data || []).forEach((s) => {
    map[s.key] = s.value;
  });

  const out = {};
  PUBLIC_SETTINGS.forEach((k) => {
    out[k] = map[k] ?? null;
  });

  ok(res, out);
});

const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('No file uploaded');
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/uploads/${req.file.filename}`;
  ok(res, { url }, 'Upload thành công');
});

module.exports = { miscController: { listNews, newsDetail, publicSettings, uploadFile } };
