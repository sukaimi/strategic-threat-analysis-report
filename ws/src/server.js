'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT_WS) || 3002;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Create and start a WebSocket server.
 * @param {object} [opts]
 * @param {number} [opts.port] - Override the listening port (useful for tests).
 * @returns {Promise<{ wss: import('ws').WebSocketServer, broadcast: Function, close: Function }>}
 */
function createServer(opts = {}) {
  const port = opts.port ?? PORT;
  const clients = new Set();

  const wss = new WebSocketServer({
    port,
    host: '127.0.0.1', // localhost-only; Nginx proxies wss:// to this
  });

  // ── Heartbeat ────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        console.log('[ws] Terminated unresponsive client');
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // ── Connection handler ───────────────────────────────────
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    clients.add(ws);

    const remote = req.socket.remoteAddress;
    console.log(`[ws] Client connected (${remote}) — total: ${clients.size}`);

    // Welcome message
    ws.send(JSON.stringify({
      type: 'welcome',
      data: { message: 'Connected to STAR MERLION WebSocket' },
      timestamp: new Date().toISOString(),
    }));

    // Send initial data snapshot if callback provided
    if (typeof opts.onConnect === 'function') {
      try { opts.onConnect(ws); } catch (_) { /* non-fatal */ }
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected — total: ${clients.size}`);
    });

    ws.on('error', (err) => {
      console.error('[ws] Client error:', err.message);
      clients.delete(ws);
    });
  });

  wss.on('error', (err) => {
    console.error('[ws] Server error:', err.message);
  });

  // ── Broadcast ────────────────────────────────────────────
  /**
   * Send a JSON message to every connected client.
   * @param {'vessels'|'flights'|'weather'|'analysis'|'alert'} type
   * @param {object} data
   */
  function broadcast(type, data) {
    const payload = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString(),
    });

    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Gracefully shut down the server.
   * @returns {Promise<void>}
   */
  function close() {
    return new Promise((resolve, reject) => {
      clearInterval(heartbeat);
      for (const ws of clients) {
        ws.terminate();
      }
      clients.clear();
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // Return a promise that resolves once the server is listening
  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      const addr = wss.address();
      console.log(`[ws] Listening on ${addr.address}:${addr.port}`);
      resolve({ wss, broadcast, close, clients });
    });
    wss.on('error', reject);
  });
}

// ── Standalone execution ───────────────────────────────────
if (require.main === module) {
  createServer().catch((err) => {
    console.error('[ws] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createServer };
