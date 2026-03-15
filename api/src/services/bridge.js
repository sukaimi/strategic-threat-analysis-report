'use strict';

const { EventEmitter } = require('node:events');
const webhook = require('./webhook');

// Singleton event bus — collectors and cron jobs emit events here,
// the bridge listens and forwards them to WebSocket clients.
const events = new EventEmitter();

// Supported event types and their WS message type strings
const EVENT_TYPES = [
  'analysis',
  'vessels',
  'flights',
  'weather',
  'alert',
  'intel',
];

/**
 * Wire the event bus to a WebSocket broadcast function.
 *
 * @param {Function} wsBroadcast — The broadcast(type, data) function from ws/src/server.js
 * @returns {{ events: EventEmitter, destroy: Function }}
 */
function createBridge(wsBroadcast) {
  if (typeof wsBroadcast !== 'function') {
    throw new TypeError('createBridge expects a broadcast function');
  }

  const listeners = {};

  for (const type of EVENT_TYPES) {
    const handler = (data) => {
      try {
        wsBroadcast(type, data);
      } catch (err) {
        console.error('[bridge] Failed to broadcast "%s":', type, err.message);
      }

      // Dispatch alerts via C2 webhooks when configured
      if (type === 'alert') {
        try {
          webhook.dispatchAlert(data);
        } catch (err) {
          console.error('[bridge] Webhook dispatch error:', err.message);
        }
      }
    };
    listeners[type] = handler;
    events.on(type, handler);
  }

  console.log('[bridge] Wired %d event types to WebSocket broadcast', EVENT_TYPES.length);

  /**
   * Remove all listeners registered by this bridge instance.
   * Useful for cleanup in tests or graceful shutdown.
   */
  function destroy() {
    for (const type of EVENT_TYPES) {
      events.removeListener(type, listeners[type]);
    }
    console.log('[bridge] Destroyed — listeners removed');
  }

  return { events, destroy };
}

module.exports = { createBridge, events, EVENT_TYPES };
