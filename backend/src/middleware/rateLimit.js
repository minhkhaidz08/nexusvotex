/**
 * Minimal in-memory sliding-window rate limiter (no external deps).
 * Each limiter instance keeps its own bucket namespace, so two limiters
 * that key on the same value (e.g. req.ip) don't share counts.
 * Suitable for a single Node process. For multi-instance deployments,
 * swap for a Redis-backed limiter.
 */
function rateLimit({ windowMs, max, message = 'Too many requests, please try again later', keyFn = (req) => req.ip }) {
  const buckets = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(key);
    }
  }, 5 * 60 * 1000);
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    const key = `${keyFn(req)}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { resetAt: now + windowMs, count: 1 });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ success: false, message });
    }
    next();
  };
}

module.exports = { rateLimit };
