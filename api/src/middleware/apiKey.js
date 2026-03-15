'use strict';

const crypto = require('crypto');
const config = require('../config');

let warnedOnce = false;

/**
 * API-key authentication middleware.
 *
 * - If config.API_KEY is empty/unset, auth is skipped (dev mode) with a
 *   one-time warning logged to the console.
 * - Accepts the key via `x-api-key` header or `Authorization: Bearer <key>`.
 * - Returns 401 if the key does not match.
 */
function apiKeyAuth(req, res, next) {
  // Dev mode — no key configured, skip auth
  if (!config.API_KEY) {
    if (!warnedOnce) {
      console.warn('[WARN] API_KEY is not set — all endpoints are unauthenticated (dev mode)');
      warnedOnce = true;
    }
    return next();
  }

  // Extract key from x-api-key header or Authorization: Bearer <key>
  let key = req.headers['x-api-key'];

  if (!key) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      key = authHeader.slice(7);
    }
  }

  if (!key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Timing-safe comparison to prevent side-channel attacks
  const keyBuf = Buffer.from(key);
  const expectedBuf = Buffer.from(config.API_KEY);
  if (keyBuf.length === expectedBuf.length && crypto.timingSafeEqual(keyBuf, expectedBuf)) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = apiKeyAuth;
