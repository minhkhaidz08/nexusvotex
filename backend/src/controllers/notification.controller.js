const { admin } = require('../config/supabase');
const { ok, sanitizeLimit } = require('../utils/helpers');
const { AppError, asyncHandler } = require('../middleware/errorHandler');

const list = asyncHandler(async (req, res) => {
  const limit = sanitizeLimit(req.query.limit, 50, 200);
  const { data, error } = await admin
    .from('notifications')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new AppError('Failed to fetch notifications', 500);
  ok(res, data || []);
});

const unreadCount = asyncHandler(async (req, res) => {
  const { count, error } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', req.userId)
    .eq('is_read', false);
  if (error) throw new AppError('Failed to count notifications', 500);
  ok(res, { count: count || 0 });
});

const markRead = asyncHandler(async (req, res) => {
  await admin.from('notifications').update({ is_read: true }).eq('id', req.params.id).eq('user_id', req.userId);
  ok(res, null, 'Đã đánh dấu đã đọc');
});

const markAllRead = asyncHandler(async (req, res) => {
  await admin.from('notifications').update({ is_read: true }).eq('user_id', req.userId).eq('is_read', false);
  ok(res, null, 'Đã đánh dấu tất cả là đã đọc');
});

module.exports = { notificationController: { list, unreadCount, markRead, markAllRead } };
