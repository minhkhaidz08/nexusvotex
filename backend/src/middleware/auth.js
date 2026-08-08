const jwt = require('jsonwebtoken');
const { admin } = require('../config/supabase');
const { AppError, asyncHandler } = require('./errorHandler');

const authMiddleware = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    throw new AppError('Unauthorized - no token provided', 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new AppError('Invalid or expired token', 401);
  }

  const { data: user, error } = await admin
    .from('users')
    .select('id, email, name, avatar_url, role, is_banned, created_at')
    .eq('id', decoded.id)
    .single();

  if (error || !user) {
    throw new AppError('User no longer exists', 401);
  }
  if (user.is_banned) {
    throw new AppError('Your account has been banned', 403);
  }

  req.user = user;
  req.userId = user.id;
  next();
});

const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return next(new AppError('Admin access required', 403));
  }
  next();
};

module.exports = { authMiddleware, adminOnly };
