const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { admin } = require('../config/supabase');
const { ok } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { logActivity } = require('../services/notification.service');

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    role: user.role,
    is_banned: user.is_banned,
    created_at: user.created_at,
  };
}

const register = asyncHandler(async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) throw new AppError('Email and password are required');
  if (password.length < 6) throw new AppError('Password must be at least 6 characters');

  const normalizedEmail = String(email).trim().toLowerCase();
  const displayName = (name || email.split('@')[0]).trim();

  const { data: existing } = await admin
    .from('users')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (existing) throw new AppError('Đăng ký không thành công, vui lòng thử lại', 409);

  const passwordHash = await bcrypt.hash(password, 10);

  const { data: user, error: uErr } = await admin
    .from('users')
    .insert({
      email: normalizedEmail,
      password_hash: passwordHash,
      name: displayName,
      role: 'user',
      is_banned: false,
    })
    .select('*')
    .single();
  if (uErr) {
    // 23505 = unique_violation: another request registered the same email
    // between our pre-check and the insert (race).
    if (uErr.code === '23505') throw new AppError('Đăng ký không thành công, vui lòng thử lại', 409);
    throw new AppError('Failed to create account', 500);
  }

  await admin.from('wallets').insert({ user_id: user.id, balance: 0, total_deposited: 0, total_spent: 0 });

  const token = signToken(user.id);
  await logActivity({ userId: user.id, action: 'register', detail: normalizedEmail, ip: req.ip });

  ok(res, { token, user: publicUser(user) }, 'Đăng ký thành công');
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new AppError('Email and password are required');

  const normalizedEmail = String(email).trim().toLowerCase();

  const { data: user, error } = await admin
    .from('users')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (error || !user) throw new AppError('Email or password incorrect', 401);

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) throw new AppError('Email or password incorrect', 401);

  if (user.is_banned) throw new AppError('Your account has been banned', 403);

  const token = signToken(user.id);
  await logActivity({ userId: user.id, action: 'login', detail: normalizedEmail, ip: req.ip });

  ok(res, { token, user: publicUser(user) }, 'Đăng nhập thành công');
});

const me = asyncHandler(async (req, res) => {
  const { data: wallet, error: wErr } = await admin
    .from('wallets')
    .select('balance')
    .eq('user_id', req.userId)
    .single();
  if (wErr) throw new AppError('Failed to load wallet', 500);
  const user = publicUser(req.user);
  user.balance = wallet ? wallet.balance : 0;
  ok(res, { user, balance: user.balance });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw new AppError('Missing password fields');
  if (newPassword.length < 6) throw new AppError('New password must be at least 6 characters');

  const { data: user, error } = await admin
    .from('users')
    .select('password_hash')
    .eq('id', req.userId)
    .single();
  if (error || !user) throw new AppError('User not found', 404);

  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) throw new AppError('Current password is incorrect', 400);

  const hash = await bcrypt.hash(newPassword, 10);
  await admin.from('users').update({ password_hash: hash }).eq('id', req.userId);
  await logActivity({ userId: req.userId, action: 'change_password', ip: req.ip });

  ok(res, null, 'Mật khẩu đã được đổi thành công');
});

const updateAvatar = asyncHandler(async (req, res) => {
  const { avatar_url } = req.body;
  if (!avatar_url) throw new AppError('avatar_url is required');

  await admin.from('users').update({ avatar_url }).eq('id', req.userId);
  ok(res, { avatar_url }, 'Đã cập nhật avatar');
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) throw new AppError('Name is required');

  await admin.from('users').update({ name: String(name).trim() }).eq('id', req.userId);
  ok(res, null, 'Đã cập nhật hồ sơ');
});

module.exports = {
  authController: {
    register,
    login,
    me,
    changePassword,
    updateAvatar,
    updateProfile,
  },
};
