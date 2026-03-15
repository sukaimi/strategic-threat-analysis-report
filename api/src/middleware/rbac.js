'use strict';

const { validateSession } = require('../services/auth');
const apiKeyAuth = require('./apiKey');

/**
 * Extract session token from cookie or Authorization header.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
  // 1. Cookie: singa-session=<token>
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('singa-session='));
    if (match) return match.split('=')[1];
  }

  // 2. Authorization: Bearer <token>  (only if it looks like a session token — 64 hex chars)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const value = authHeader.slice(7);
    if (/^[a-f0-9]{64}$/.test(value)) return value;
  }

  return null;
}

/**
 * Middleware: require authentication.
 *
 * Tries session token first, then falls back to API key auth
 * (for machine-to-machine / collector requests).
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);

  if (token) {
    const user = validateSession(token);
    if (user) {
      req.user = user;
      return next();
    }
    // Token present but invalid — don't fall through to apiKey,
    // unless there's also an x-api-key header
    if (!req.headers['x-api-key'] && !(req.headers.authorization && !req.headers.authorization.startsWith('Bearer '))) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }
  }

  // Fall back to API key auth (sets no req.user but allows the request)
  apiKeyAuth(req, res, (err) => {
    if (err) return next(err);
    // API key auth passed — set a synthetic user so downstream works
    if (!req.user) {
      req.user = { id: 0, username: 'api-key', role: 'operator' };
    }
    next();
  });
}

/**
 * Middleware factory: require one of the specified roles.
 * Must be used AFTER requireAuth.
 *
 * Role hierarchy (each includes all below):
 *   admin > commander > analyst > operator
 *
 * @param {...string} roles — allowed roles
 * @returns {Function} Express middleware
 */
function requireRole(...roles) {
  const HIERARCHY = { operator: 1, analyst: 2, commander: 3, admin: 4 };

  // Find the minimum required level
  const minLevel = Math.min(...roles.map(r => HIERARCHY[r] || 0));

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userLevel = HIERARCHY[req.user.role] || 0;
    if (userLevel >= minLevel) {
      return next();
    }

    return res.status(403).json({ error: 'Insufficient permissions', required: roles });
  };
}

module.exports = { requireAuth, requireRole };
