'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const rateLimit = require('../src/middleware/rateLimit');

/**
 * Create a minimal mock request/response pair.
 */
function createMocks(ip) {
  const req = {
    ip: ip || '127.0.0.1',
    socket: { remoteAddress: ip || '127.0.0.1' },
  };

  const headers = {};
  const res = {
    statusCode: 200,
    _json: null,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res._json = body;
    },
  };

  return { req, res, headers };
}

describe('rateLimit middleware', () => {
  let middleware;

  beforeEach(() => {
    middleware = rateLimit({ maxRequests: 3, windowMs: 1000 });
  });

  it('allows requests under the limit', (_, done) => {
    const { req, res } = createMocks();

    middleware(req, res, () => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.getHeader('X-RateLimit-Limit'), 3);
      assert.equal(res.getHeader('X-RateLimit-Remaining'), 2);
      done();
    });
  });

  it('tracks remaining requests correctly', (_, done) => {
    const { req, res } = createMocks('10.0.0.1');

    let callCount = 0;
    const next = () => { callCount++; };

    // Request 1
    middleware(req, res, next);
    assert.equal(res.getHeader('X-RateLimit-Remaining'), 2);

    // Request 2
    middleware(req, res, next);
    assert.equal(res.getHeader('X-RateLimit-Remaining'), 1);

    // Request 3
    middleware(req, res, next);
    assert.equal(res.getHeader('X-RateLimit-Remaining'), 0);

    assert.equal(callCount, 3);
    done();
  });

  it('returns 429 when limit exceeded', () => {
    const { req, res } = createMocks('10.0.0.2');
    const next = () => {};

    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      middleware(req, res, next);
    }

    // 4th request should be blocked
    middleware(req, res, next);

    assert.equal(res.statusCode, 429);
    assert.ok(res._json);
    assert.equal(res._json.error, 'Too Many Requests');
    assert.ok(res._json.retryAfter > 0);
  });

  it('resets after the time window', async () => {
    const shortLimiter = rateLimit({ maxRequests: 1, windowMs: 100 });
    const { req, res } = createMocks('10.0.0.3');
    const next = () => {};

    // First request — allowed
    shortLimiter(req, res, next);
    assert.equal(res.statusCode, 200);

    // Second request — blocked
    shortLimiter(req, res, next);
    assert.equal(res.statusCode, 429);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Reset response status for clarity
    res.statusCode = 200;
    res._json = null;

    // Request after window — should be allowed again
    let called = false;
    shortLimiter(req, res, () => { called = true; });
    assert.ok(called, 'next() should have been called after window reset');
    assert.equal(res.statusCode, 200);

    clearInterval(shortLimiter._cleanup);
  });

  it('isolates rate limits per IP', () => {
    const { req: req1, res: res1 } = createMocks('192.168.1.1');
    const { req: req2, res: res2 } = createMocks('192.168.1.2');
    const next = () => {};

    // Exhaust limit for IP 1
    for (let i = 0; i < 4; i++) {
      middleware(req1, res1, next);
    }
    assert.equal(res1.statusCode, 429);

    // IP 2 should still be allowed
    let called = false;
    middleware(req2, res2, () => { called = true; });
    assert.ok(called, 'Different IP should not be rate limited');
  });

  it('uses default values when no options provided', (_, done) => {
    const defaultMiddleware = rateLimit();
    const { req, res } = createMocks();

    defaultMiddleware(req, res, () => {
      assert.equal(res.getHeader('X-RateLimit-Limit'), 100);
      assert.equal(res.getHeader('X-RateLimit-Remaining'), 99);
      clearInterval(defaultMiddleware._cleanup);
      done();
    });
  });
});
