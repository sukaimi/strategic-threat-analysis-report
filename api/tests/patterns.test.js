'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

const {
  buildBaseline,
  checkDeviation,
  MIN_DATA_POINTS,
  SPEED_DEVIATION_FACTOR,
  POSITION_DEVIATION_NM,
} = require('../src/services/patterns');

let db;

before(() => {
  close();
  db = getDb(':memory:');
});

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// Helper: insert N vessel records for a given MMSI
// ---------------------------------------------------------------------------
function insertVesselRecords(mmsi, count, opts = {}) {
  const { baseLat = 1.30, baseLon = 103.85, speed = 8, heading = 90 } = opts;
  const stmt = db.prepare(
    "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ? || ' minutes'))"
  );

  for (let i = 0; i < count; i++) {
    // Slight variation in position
    const lat = baseLat + (Math.random() - 0.5) * 0.02;
    const lon = baseLon + (Math.random() - 0.5) * 0.02;
    stmt.run(mmsi, lat, lon, speed + (Math.random() - 0.5) * 2, heading, 'MV Baseline', String(-i * 5));
  }
}

// ---------------------------------------------------------------------------
// buildBaseline
// ---------------------------------------------------------------------------
describe('buildBaseline', () => {
  it('returns null for MMSI with insufficient data points', () => {
    // Insert fewer than MIN_DATA_POINTS records
    const stmt = db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    );
    for (let i = 0; i < MIN_DATA_POINTS - 1; i++) {
      stmt.run('INSUF0001', 1.30, 103.85, 8, 90, 'MV Few');
    }

    const baseline = buildBaseline(db, 'INSUF0001');
    assert.equal(baseline, null);
  });

  it('returns baseline with correct structure for sufficient data', () => {
    insertVesselRecords('BASE00001', 15);

    const baseline = buildBaseline(db, 'BASE00001');
    assert.ok(baseline, 'Should return baseline');
    assert.equal(baseline.dataPoints, 15);
    assert.ok(typeof baseline.avgSpeed === 'number');
    assert.ok(typeof baseline.minSpeed === 'number');
    assert.ok(typeof baseline.maxSpeed === 'number');
    assert.ok(Array.isArray(baseline.headingRange));
    assert.equal(baseline.headingRange.length, 2);
    assert.ok(baseline.bbox);
    assert.ok(typeof baseline.bbox.latMin === 'number');
    assert.ok(typeof baseline.bbox.latMax === 'number');
    assert.ok(typeof baseline.bbox.lonMin === 'number');
    assert.ok(typeof baseline.bbox.lonMax === 'number');
    assert.ok(Array.isArray(baseline.hourDistribution));
    assert.equal(baseline.hourDistribution.length, 24);
  });

  it('average speed is within expected range', () => {
    // Records inserted with speed ~8 +/- 1
    const baseline = buildBaseline(db, 'BASE00001');
    assert.ok(baseline.avgSpeed > 5 && baseline.avgSpeed < 12, `avgSpeed ${baseline.avgSpeed} should be near 8`);
  });
});

// ---------------------------------------------------------------------------
// checkDeviation
// ---------------------------------------------------------------------------
describe('checkDeviation', () => {
  it('returns null for MMSI with insufficient history', () => {
    const result = checkDeviation(db, 'NODATA001', { lat: 1.30, lon: 103.85, speed_kt: 10 });
    assert.equal(result, null);
  });

  it('detects speed deviation when current speed > 2x average', () => {
    // BASE00001 has avg speed ~8. Current at 25 should trigger.
    const result = checkDeviation(db, 'BASE00001', { lat: 1.30, lon: 103.85, speed_kt: 25 });
    assert.ok(result, 'Should return result');
    assert.ok(result.deviations.length > 0, 'Should have at least one deviation');
    const speedDev = result.deviations.find((d) => d.includes('Speed'));
    assert.ok(speedDev, 'Should flag speed deviation');
  });

  it('does not flag normal speed', () => {
    const result = checkDeviation(db, 'BASE00001', { lat: 1.30, lon: 103.85, speed_kt: 9 });
    assert.ok(result, 'Should return result');
    const speedDev = result.deviations.find((d) => d.includes('Speed'));
    assert.ok(!speedDev, 'Should not flag normal speed');
  });

  it('detects position deviation when vessel is far from typical area', () => {
    // BASE00001 operates around lat 1.30, lon 103.85. Position at lat 2.5 should be far.
    const result = checkDeviation(db, 'BASE00001', { lat: 2.5, lon: 105.0, speed_kt: 8 });
    assert.ok(result, 'Should return result');
    const posDev = result.deviations.find((d) => d.includes('operating area'));
    assert.ok(posDev, 'Should flag position deviation');
  });

  it('does not flag position within normal area', () => {
    const result = checkDeviation(db, 'BASE00001', { lat: 1.30, lon: 103.85, speed_kt: 8 });
    assert.ok(result, 'Should return result');
    const posDev = result.deviations.find((d) => d.includes('operating area'));
    assert.ok(!posDev, 'Should not flag normal position');
  });
});
