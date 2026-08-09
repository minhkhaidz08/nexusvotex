/**
 * NexusVotex - Seed/init script
 * Creates the admin account and base shop settings only.
 * Products, inventory keys, news and discount codes are managed directly
 * via the admin panel, not by this script.
 *
 * Usage:
 *   1. Create tables first (run supabase/schema.sql in the Supabase SQL editor)
 *   2. npm run seed   (requires .env with SUPABASE_SERVICE_ROLE_KEY)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function upsertUser(email, data) {
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existing) {
    await supabase.from('users').update(data).eq('id', existing.id);
    return existing.id;
  }
  const { data: created, error } = await supabase
    .from('users')
    .insert({ email, ...data })
    .select('id')
    .single();
  if (error) throw error;
  return created.id;
}

async function ensureWallet(userId) {
  const { data: existing } = await supabase.from('wallets').select('id').eq('user_id', userId).maybeSingle();
  if (!existing) {
    await supabase.from('wallets').insert({ user_id: userId, balance: 0, total_deposited: 0, total_spent: 0 });
  }
}

async function seed() {
  console.log('[seed] Starting...');

  // 1. Admin account
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@nexusvotex.vn';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123456';
  const adminId = await upsertUser(adminEmail, {
    password_hash: await bcrypt.hash(adminPassword, 10),
    name: 'Quản trị viên',
    role: 'admin',
    is_banned: false,
  });
  await ensureWallet(adminId);
  console.log(`[seed] Admin ready: ${adminEmail} / ${adminPassword}`);

  // 2. Settings (empty values are meant to be filled via the admin panel)
  const settings = [
    ['shop_name', 'NexusVotex', 'Tên shop'],
    ['slogan', '', 'Khẩu hiệu'],
    ['logo_url', '', 'Logo'],
    ['banner_url', '', 'Banner'],
    ['main_color', '#7c3aed', 'Màu chủ đạo'],
    ['background_color', '#0b0f19', 'Màu nền'],
    ['facebook', '', 'Facebook'],
    ['discord', '', 'Discord'],
    ['telegram', '', 'Telegram'],
    ['zalo', '', 'Zalo'],
    ['email', '', 'Email hỗ trợ'],
    ['phone', '', 'Số điện thoại'],
    ['announcement', '', 'Thông báo'],
    ['notifications_enabled', 'true', 'Bật/tắt thông báo'],
    ['terms', '', 'Điều khoản'],
    ['privacy_policy', '', 'Chính sách bảo mật'],
    ['payment_guide', '', 'Hướng dẫn thanh toán'],
  ];

  for (const [key, value, description] of settings) {
    const { data: existing } = await supabase.from('settings').select('id').eq('key', key).maybeSingle();
    if (existing) {
      await supabase.from('settings').update({ value, description }).eq('id', existing.id);
    } else {
      await supabase.from('settings').insert({ key, value, description });
    }
  }
  console.log('[seed] Base settings ready');

  console.log('[seed] Done! ✅');
  process.exit(0);
}

seed().catch((err) => {
  console.error('[seed] Failed:', err.message);
  process.exit(1);
});