'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, events } = require('../src/services/bridge');

describe('bridge', () => {
  let bridge;
  let broadcasts;
  let mockBroadcast;

  beforeEach(() => {
    broadcasts = [];
    mockBroadcast = (type, data) => {
      broadcasts.push({ type, data });
    };
    bridge = createBridge(mockBroadcast);
  });

  afterEach(() => {
    if (bridge) bridge.destroy();
    events.removeAllListeners();
  });

  it('createBridge registers event listeners for all event types', () => {
    const expectedTypes = ['analysis', 'vessels', 'flights', 'weather', 'alert'];
    for (const type of expectedTypes) {
      assert.ok(
        events.listenerCount(type) >= 1,
        `Expected at least one listener for "${type}"`
      );
    }
  });

  it('throws if wsBroadcast is not a function', () => {
    assert.throws(() => createBridge(null), {
      name: 'TypeError',
      message: /broadcast function/,
    });
    assert.throws(() => createBridge('not-a-function'), {
      name: 'TypeError',
      message: /broadcast function/,
    });
  });

  it('emitting "analysis" event triggers broadcast with correct type', () => {
    const payload = { composite_score: 42, threat_level: 'MEDIUM' };
    events.emit('analysis', payload);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'analysis');
    assert.deepEqual(broadcasts[0].data, payload);
  });

  it('emitting "vessels" event triggers broadcast with correct type', () => {
    const payload = [{ mmsi: '123456789', name: 'MV Test' }];
    events.emit('vessels', payload);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'vessels');
    assert.deepEqual(broadcasts[0].data, payload);
  });

  it('emitting "flights" event triggers broadcast with correct type', () => {
    const payload = [{ callsign: 'SIA321', altitude: 35000 }];
    events.emit('flights', payload);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'flights');
    assert.deepEqual(broadcasts[0].data, payload);
  });

  it('emitting "weather" event triggers broadcast with correct type', () => {
    const payload = { temp: 31, humidity: 85, condition: 'Thunderstorm' };
    events.emit('weather', payload);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'weather');
    assert.deepEqual(broadcasts[0].data, payload);
  });

  it('emitting "alert" event triggers broadcast with correct type', () => {
    const payload = { severity: 'HIGH', title: 'AIS Dark Vessel', description: 'MMSI 999 went dark' };
    events.emit('alert', payload);

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].type, 'alert');
    assert.deepEqual(broadcasts[0].data, payload);
  });

  it('destroy removes listeners so events no longer broadcast', () => {
    bridge.destroy();
    events.emit('analysis', { test: true });

    assert.equal(broadcasts.length, 0);
  });

  it('handles broadcast errors gracefully without crashing', () => {
    bridge.destroy();

    const errorBroadcast = () => { throw new Error('WS send failed'); };
    const errorBridge = createBridge(errorBroadcast);

    // Should not throw
    assert.doesNotThrow(() => {
      events.emit('analysis', { test: true });
    });

    errorBridge.destroy();
  });
});
