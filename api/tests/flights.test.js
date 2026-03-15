'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseFlightData, getStats } = require('../src/collectors/flights');

describe('Flight data collector — parseFlightData', () => {
  it('correctly extracts aircraft data from adsb.fi format', () => {
    const raw = {
      ac: [
        {
          hex: 'abc123',
          flight: 'SQ321   ',
          lat: 1.234,
          lon: 103.456,
          alt_baro: 35000,
          gs: 450,
          track: 180,
          squawk: '1234',
          category: 'A3',
          t: 'B77W',
        },
      ],
      total: 1,
      now: 1234567890.123,
    };

    const rows = parseFlightData(raw);
    assert.equal(rows.length, 1);

    const r = rows[0];
    assert.equal(r.callsign, 'SQ321');
    assert.equal(r.squawk, '1234');
    assert.equal(r.lat, 1.234);
    assert.equal(r.lon, 103.456);
    assert.equal(r.altitude_ft, 35000);
    assert.equal(r.speed_kt, 450);
    assert.equal(r.heading, 180);
  });

  it('trims whitespace from callsign', () => {
    const raw = {
      ac: [
        { flight: '  SIA215  ', lat: 1.0, lon: 103.0, alt_baro: 10000, gs: 200, track: 90, squawk: '4567' },
      ],
    };

    const rows = parseFlightData(raw);
    assert.equal(rows[0].callsign, 'SIA215');
  });

  it('handles empty response (no aircraft)', () => {
    const rows = parseFlightData({ ac: [], total: 0, now: 0 });
    assert.equal(rows.length, 0);
  });

  it('handles null / undefined input gracefully', () => {
    assert.deepEqual(parseFlightData(null), []);
    assert.deepEqual(parseFlightData(undefined), []);
    assert.deepEqual(parseFlightData({}), []);
  });

  it('handles malformed data — missing fields become null', () => {
    const raw = {
      ac: [
        { hex: 'xyz789' }, // no flight, lat, lon, alt_baro, gs, track, squawk
      ],
    };

    const rows = parseFlightData(raw);
    assert.equal(rows.length, 1);

    const r = rows[0];
    assert.equal(r.callsign, null);
    assert.equal(r.squawk, null);
    assert.equal(r.lat, null);
    assert.equal(r.lon, null);
    assert.equal(r.altitude_ft, null);
    assert.equal(r.speed_kt, null);
    assert.equal(r.heading, null);
  });

  it('handles mixed valid and incomplete aircraft entries', () => {
    const raw = {
      ac: [
        { flight: 'TGR781', lat: 2.0, lon: 104.0, alt_baro: 28000, gs: 380, track: 270, squawk: '0001' },
        { hex: 'nodata' },
        { flight: '', lat: 1.5, lon: 103.5, alt_baro: 5000, gs: 120, track: 45, squawk: '7700' },
      ],
    };

    const rows = parseFlightData(raw);
    assert.equal(rows.length, 3);

    assert.equal(rows[0].callsign, 'TGR781');
    assert.equal(rows[1].callsign, null);
    // empty string flight should become null
    assert.equal(rows[2].callsign, null);
    assert.equal(rows[2].squawk, '7700');
  });
});

describe('Flight data collector — getStats', () => {
  it('returns correct structure', () => {
    const stats = getStats();
    assert.equal(typeof stats.polling, 'boolean');
    assert.equal(typeof stats.aircraftCount, 'number');
    assert.equal(typeof stats.pollInterval, 'number');
    assert.ok('lastPollAt' in stats);
  });

  it('reports not polling when collector has not been started', () => {
    const stats = getStats();
    assert.equal(stats.polling, false);
  });
});
