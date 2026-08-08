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

const path = require('path');
const fs = require('fs');

const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Vui lòng chọn file ảnh để tải lên');

  const ext = path.extname(req.file.originalname).toLowerCase();
  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const filePath = `uploads/${fileName}`;

  let finalUrl = null;

  // Try uploading to Supabase Storage bucket 'uploads'
  try {
    const { data, error } = await admin.storage
      .from('uploads')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (!error && data) {
      const { data: publicData } = admin.storage.from('uploads').getPublicUrl(filePath);
      if (publicData?.publicUrl) {
        finalUrl = publicData.publicUrl;
      }
    } else {
      console.warn('[Supabase Storage] Upload notice:', error?.message);
    }
  } catch (err) {
    console.warn('[Supabase Storage] Upload exception:', err.message);
  }

  // Graceful fallback to local disk if Supabase Storage bucket is missing or unconfigured
  if (!finalUrl) {
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const localPath = path.join(uploadDir, fileName);
    fs.writeFileSync(localPath, req.file.buffer);

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    finalUrl = `${base}/uploads/${fileName}`;
  }

  ok(res, { url: finalUrl }, 'Upload ảnh thành công');
});

module.exports = { miscController: { listNews, newsDetail, publicSettings, uploadFile } };
