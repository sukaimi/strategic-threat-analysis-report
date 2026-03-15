'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAISMessage,
  nextBackoff,
  getStats,
  flushBatch,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  _getBatch,
  _pushBatch,
  _resetBatch,
} = require('../src/collectors/ais');

// ---------------------------------------------------------------------------
// parseAISMessage
// ---------------------------------------------------------------------------
describe('parseAISMessage', () => {
  it('correctly extracts vessel data from a valid AISStream message', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: 123456789,
        ShipName: '  SOME VESSEL  ',
        time_utc: '2024-01-01T00:00:00Z',
      },
      Message: {
        PositionReport: {
          Latitude: 1.234,
          Longitude: 103.456,
          Sog: 12.5,
          TrueHeading: 180,
          NavigationalStatus: 0,
        },
      },
    };

    const result = parseAISMessage(msg);

    assert.equal(result.mmsi, '123456789');
    assert.equal(result.lat, 1.234);
    assert.equal(result.lon, 103.456);
    assert.equal(result.speed_kt, 12.5);
    assert.equal(result.heading, 180);
    assert.equal(result.vessel_name, 'SOME VESSEL');
    assert.equal(result.vessel_type, null);
    assert.equal(result.time_utc, '2024-01-01T00:00:00Z');
  });

  it('returns null for non-PositionReport messages', () => {
    const msg = {
      MessageType: 'StaticDataReport',
      MetaData: { MMSI: 111111111 },
      Message: {},
    };
    assert.equal(parseAISMessage(msg), null);
  });

  it('returns null when MetaData is missing', () => {
    const msg = {
      MessageType: 'PositionReport',
      Message: { PositionReport: { Latitude: 1, Longitude: 2 } },
    };
    assert.equal(parseAISMessage(msg), null);
  });

  it('returns null when PositionReport payload is missing', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 111111111, ShipName: 'TEST' },
      Message: {},
    };
    assert.equal(parseAISMessage(msg), null);
  });

  it('returns null for null/undefined input', () => {
    assert.equal(parseAISMessage(null), null);
    assert.equal(parseAISMessage(undefined), null);
  });

  it('handles missing optional fields gracefully', () => {
    const msg = {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 999999999 },
      Message: {
        PositionReport: {
          Latitude: 2.0,
          Longitude: 104.0,
        },
      },
    };

    const result = parseAISMessage(msg);
    assert.equal(result.mmsi, '999999999');
    assert.equal(result.lat, 2.0);
    assert.equal(result.lon, 104.0);
    assert.equal(result.speed_kt, null);
    assert.equal(result.heading, null);
    assert.equal(result.vessel_name, null);
    assert.equal(result.time_utc, null);
  });
});

// ---------------------------------------------------------------------------
// Batch accumulation
// ---------------------------------------------------------------------------
describe('batch accumulation', () => {
  beforeEach(() => {
    _resetBatch();
  });

  afterEach(() => {
    _resetBatch();
  });

  it('accumulates parsed records in the batch', () => {
    const record = {
      mmsi: '123456789',
      lat: 1.0,
      lon: 103.0,
      speed_kt: 10,
      heading: 90,
      vessel_name: 'TEST',
      vessel_type: null,
      time_utc: '2024-01-01T00:00:00Z',
    };

    _pushBatch(record);
    _pushBatch(record);
    _pushBatch(record);

    assert.equal(_getBatch().length, 3);
  });

  it('flushBatch clears the batch (without DB it will error but batch resets)', () => {
    const record = {
      mmsi: '111',
      lat: 1,
      lon: 2,
      speed_kt: 5,
      heading: 0,
      vessel_name: 'X',
      vessel_type: null,
    };

    _pushBatch(record);
    assert.equal(_getBatch().length, 1);

    // flushBatch will splice the batch even if DB write fails
    // (records are spliced before the DB call attempt)
    flushBatch();

    assert.equal(_getBatch().length, 0);
  });

  it('flushBatch is a no-op when batch is empty', () => {
    // Should not throw
    flushBatch();
    assert.equal(_getBatch().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Reconnect backoff
// ---------------------------------------------------------------------------
describe('reconnect backoff', () => {
  it('doubles from initial value', () => {
    assert.equal(nextBackoff(INITIAL_BACKOFF_MS), 2000);
  });

  it('follows exponential sequence: 1s -> 2s -> 4s -> 8s -> 16s -> 30s -> 30s', () => {
    let b = INITIAL_BACKOFF_MS; // 1000
    const expected = [2000, 4000, 8000, 16000, 30000, 30000];

    for (const exp of expected) {
      b = nextBackoff(b);
      assert.equal(b, exp, `Expected ${exp} but got ${b}`);
    }
  });

  it('never exceeds MAX_BACKOFF_MS', () => {
    let b = 16000;
    b = nextBackoff(b); // 32000 -> capped at 30000
    assert.equal(b, MAX_BACKOFF_MS);

    b = nextBackoff(b); // 30000 * 2 = 60000 -> capped at 30000
    assert.equal(b, MAX_BACKOFF_MS);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------
describe('getStats', () => {
  it('returns the correct structure', () => {
    const stats = getStats();

    assert.equal(typeof stats.connected, 'boolean');
    assert.equal(typeof stats.messagesReceived, 'number');
    assert.ok('lastMessageAt' in stats);
    assert.equal(typeof stats.batchSize, 'number');
  });

  it('batchSize reflects current batch length', () => {
    _resetBatch();
    assert.equal(getStats().batchSize, 0);

    _pushBatch({ mmsi: '1' });
    assert.equal(getStats().batchSize, 1);

    _pushBatch({ mmsi: '2' });
    assert.equal(getStats().batchSize, 2);

    _resetBatch();
    assert.equal(getStats().batchSize, 0);
  });
});
