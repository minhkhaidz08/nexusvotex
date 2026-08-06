function ok(res, data, message = 'Success') {
  return res.json({ success: true, message, data });
}

function generateOrderCode(prefix = 'KH') {
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `${prefix}${ts}${rand}`;
}

function generatePaymentCode(prefix = 'PAY') {
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `${prefix}${ts}${rand}`;
}

function generateKeyCode(prefix = 'KEY') {
  const ts = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 8);
  return `${prefix}${ts}${rand}`;
}

function maskKey(key) {
  if (key.length <= 8) return key;
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * Sanitize a `limit` query param: non-numeric/negative -> fallback,
 * clamp to max so callers can't ask for unbounded result sets.
 */
function sanitizeLimit(value, fallback = 50, max = 200) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Sanitize a 1-based `page` query param.
 */
function sanitizePage(value, fallback = 1) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/**
 * Build a URL-safe slug from Vietnamese text (removes diacritics).
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

/**
 * Strip characters that PostgREST treats specially inside `.or()` filter
 * strings (commas separate conditions, parens/semicolons break out of the
 * expression, % and * are ilike wildcards). Prevents filter injection via
 * user-controlled search terms.
 */
function sanitizeSearch(value) {
  return String(value || '').replace(/[,();%*]/g, ' ').trim().slice(0, 100);
}

module.exports = { ok, generateOrderCode, generatePaymentCode, generateKeyCode, maskKey, sanitizeLimit, sanitizePage, sanitizeSearch, slugify };
