const { admin } = require('../config/supabase');

/**
 * Broadcast a notification to a single user or all users.
 * @param {string|null} userId - target user, null = broadcast to all users
 * @param {string} title
 * @param {string} content
 * @param {string} type - notification type
 */
async function createNotification({ userId = null, title, content, type = 'info' }) {
  if (userId) {
    const { error } = await admin.from('notifications').insert({
      user_id: userId,
      title,
      content,
      type,
    });
    if (error) console.error('[notify] insert error:', error.message);
    return;
  }

  // Broadcast: fetch all active users and insert for each (batch)
  const { data: users, error: uErr } = await admin
    .from('users')
    .select('id')
    .eq('is_banned', false);

  if (uErr || !users || users.length === 0) return;

  const rows = users.map((u) => ({
    user_id: u.id,
    title,
    content,
    type,
  }));

  // PostgREST caps inserts at ~1000 rows per call; chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin.from('notifications').insert(rows.slice(i, i + CHUNK));
    if (error) console.error('[notify] broadcast error:', error.message);
  }
}

async function logActivity({ userId = null, action, detail = '', ip = '' }) {
  const { error } = await admin.from('activity_logs').insert({
    user_id: userId,
    action,
    detail,
    ip,
  });
  if (error) console.error('[activity] insert error:', error.message);
}

module.exports = { createNotification, logActivity };
