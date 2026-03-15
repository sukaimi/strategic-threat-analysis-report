'use strict';

/**
 * Simple in-memory rate limiter (no Redis required).
 *
 * @param {object} [opts]
 * @param {number} [opts.maxRequests=100]  — Max requests allowed per window.
 * @param {number} [opts.windowMs=60000]   — Window duration in milliseconds.
 * @returns {Function} Express middleware
 */
function rateLimit(opts = {}) {
  const maxRequests = opts.maxRequests ?? 100;
  const windowMs = opts.windowMs ?? 60_000;

  // Map<string, { count: number, resetAt: number }>
  const store = new Map();

  // Periodic cleanup so the map doesn't grow unbounded
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) {
        store.delete(key);
      }
    }
  }, windowMs);

  // Allow the timer to not prevent process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  function middleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count += 1;

    // Set rate-limit headers
    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.ceil((entry.resetAt - now) / 1000)}s.`,
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  }

  // Expose internals for testing
  middleware._store = store;
  middleware._cleanup = cleanupInterval;

  return middleware;
}

module.exports = rateLimit;
