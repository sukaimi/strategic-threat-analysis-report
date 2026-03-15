'use strict';

const crypto = require('node:crypto');
const config = require('../config');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _endpoints = [];
let _totalDispatched = 0;
let _totalFailed = 0;
let _lastDispatchAt = null;
const _endpointStatus = new Map(); // url -> { ok: number, fail: number, lastStatus: string }

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function _loadEndpoints() {
  const raw = config.WEBHOOK_URLS || '';
  _endpoints = raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  return _endpoints;
}

// Load on import so other modules can check immediately
_loadEndpoints();

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function _sign(payload) {
  const secret = config.WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Dispatch with retry
// ---------------------------------------------------------------------------

/**
 * Send a POST request to a single endpoint with retry logic.
 * Fire-and-forget — errors are logged but never thrown to the caller.
 */
async function _postWithRetry(url, body, attempt = 1) {
  const jsonBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = _sign(jsonBody);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'STAR-MERLION-Webhook/1.0',
  };
  if (signature) {
    headers['X-Signature-256'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: jsonBody,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    // Success
    _trackEndpoint(url, true, `${res.status}`);
    console.log(`[webhook] Dispatched to ${url} (attempt ${attempt}) — ${res.status}`);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[webhook] Attempt ${attempt} failed for ${url}: ${err.message}. Retrying in ${delay}ms...`);
      await _sleep(delay);
      return _postWithRetry(url, body, attempt + 1);
    }

    // Exhausted retries
    _trackEndpoint(url, false, err.message);
    _totalFailed++;
    console.error(`[webhook] All ${MAX_RETRIES} attempts failed for ${url}: ${err.message}`);
  }
}

function _trackEndpoint(url, success, status) {
  const entry = _endpointStatus.get(url) || { ok: 0, fail: 0, lastStatus: '' };
  if (success) {
    entry.ok++;
  } else {
    entry.fail++;
  }
  entry.lastStatus = status;
  _endpointStatus.set(url, entry);
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch an alert payload to all configured webhook endpoints.
 * Fire-and-forget — dispatches are run concurrently and errors are logged
 * but never propagated.
 *
 * @param {object} alert — the alert object to send
 */
function dispatchAlert(alert) {
  // Reload endpoints in case env changed at runtime
  _loadEndpoints();

  if (_endpoints.length === 0) return;

  const payload = {
    event: 'alert',
    timestamp: new Date().toISOString(),
    data: alert,
  };

  _totalDispatched++;
  _lastDispatchAt = payload.timestamp;

  // Fire-and-forget all endpoints concurrently
  for (const url of _endpoints) {
    _postWithRetry(url, payload).catch(() => {
      // Swallow — _postWithRetry already logs
    });
  }
}

/**
 * Return dispatch statistics.
 */
function getStats() {
  _loadEndpoints();

  const endpoints = {};
  for (const url of _endpoints) {
    endpoints[url] = _endpointStatus.get(url) || { ok: 0, fail: 0, lastStatus: 'never' };
  }

  return {
    configured: _endpoints.length,
    totalDispatched: _totalDispatched,
    totalFailed: _totalFailed,
    lastDispatchAt: _lastDispatchAt,
    endpoints,
  };
}

module.exports = { dispatchAlert, getStats };
