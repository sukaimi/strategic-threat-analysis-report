'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/server');

/**
 * Helper: open a WebSocket client and collect the welcome message.
 * Registers the message listener before the connection opens so we
 * never miss the fast-arriving welcome payload.
 * @param {number} port
 * @returns {Promise<{ ws: WebSocket, welcome: object }>}
 */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // Capture the first message (welcome) immediately
    ws.once('message', (raw) => {
      const welcome = JSON.parse(raw.toString());
      resolve({ ws, welcome });
    });
    ws.on('error', reject);
  });
}

/**
 * Helper: wait for the next message on a WebSocket and parse it.
 * @param {WebSocket} ws
 * @returns {Promise<object>}
 */
function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

/**
 * Helper: close a client and wait for the close event to complete.
 * @param {WebSocket} ws
 * @returns {Promise<void>}
 */
function closeClient(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => setTimeout(resolve, 20));
    ws.close();
  });
}

describe('WebSocket server', () => {
  let server; // { wss, broadcast, close, clients }
  let port;

  before(async () => {
    // Port 0 lets the OS pick a random available port
    server = await createServer({ port: 0 });
    port = server.wss.address().port;
  });

  after(async () => {
    await server.close();
  });

  // ── Test 1: server starts and accepts connections ────────
  it('accepts a WebSocket connection', async () => {
    const { ws } = await connect(port);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeClient(ws);
  });

  // ── Test 2: welcome message on connect ───────────────────
  it('sends a welcome message with timestamp on connect', async () => {
    const { ws, welcome } = await connect(port);

    assert.equal(welcome.type, 'welcome');
    assert.equal(typeof welcome.data.message, 'string');
    assert.ok(welcome.timestamp, 'timestamp should be present');
    // Verify timestamp is a valid ISO-8601 date
    assert.ok(!isNaN(Date.parse(welcome.timestamp)), 'timestamp should be valid ISO-8601');

    await closeClient(ws);
  });

  // ── Test 3: broadcast delivers to all connected clients ──
  it('broadcasts a message to all connected clients', async () => {
    const { ws: ws1 } = await connect(port);
    const { ws: ws2 } = await connect(port);

    // Set up listeners before broadcasting
    const p1 = nextMessage(ws1);
    const p2 = nextMessage(ws2);

    const payload = { mmsi: '123456789', name: 'MV Test' };
    server.broadcast('vessels', payload);

    const [msg1, msg2] = await Promise.all([p1, p2]);

    assert.equal(msg1.type, 'vessels');
    assert.deepEqual(msg1.data, payload);
    assert.ok(msg1.timestamp);

    assert.equal(msg2.type, 'vessels');
    assert.deepEqual(msg2.data, payload);

    await Promise.all([closeClient(ws1), closeClient(ws2)]);
  });

  // ── Test 4: disconnected clients are removed from Set ────
  it('removes disconnected clients from the Set', async () => {
    const { ws } = await connect(port);

    // Client should be tracked
    assert.ok(server.clients.size >= 1, 'client should be in the Set');
    const sizeBefore = server.clients.size;

    // Close and wait for server to process the close event
    await closeClient(ws);

    assert.equal(server.clients.size, sizeBefore - 1, 'client should be removed after disconnect');
  });
});
