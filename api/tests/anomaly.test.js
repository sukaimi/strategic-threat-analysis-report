'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

const {
  haversineNm,
  isInZone,
  isInAnchorageOrTSS,
  isInTSS,
  runAnomalyChecks,
  ZONES,
} = require('../src/services/anomaly');

let db;

before(() => {
  close();
  db = getDb(':memory:');
});

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// haversineNm
// ---------------------------------------------------------------------------
describe('haversineNm', () => {
  it('returns 0 for identical points', () => {
    assert.equal(haversineNm(1.3, 103.8, 1.3, 103.8), 0);
  });

  it('calculates Singapore to Batam (~11 NM)', () => {
    // Singapore (1.29, 103.85) -> Batam (1.08, 104.03) ~ 15 NM
    const dist = haversineNm(1.29, 103.85, 1.08, 104.03);
    assert.ok(dist > 10 && dist < 20, `Expected ~14 NM, got ${dist.toFixed(2)}`);
  });

  it('calculates Singapore to Johor (~8 NM)', () => {
    // Singapore (1.29, 103.85) -> Johor Bahru (1.46, 103.76) ~ 11 NM
    const dist = haversineNm(1.29, 103.85, 1.46, 103.76);
    assert.ok(dist > 8 && dist < 15, `Expected ~11 NM, got ${dist.toFixed(2)}`);
  });

  it('returns correct known distance — equator one degree longitude ~ 60 NM', () => {
    const dist = haversineNm(0, 0, 0, 1);
    assert.ok(dist > 59 && dist < 61, `Expected ~60 NM, got ${dist.toFixed(2)}`);
  });

  it('is symmetric', () => {
    const d1 = haversineNm(1.3, 103.8, 2.0, 104.0);
    const d2 = haversineNm(2.0, 104.0, 1.3, 103.8);
    assert.ok(Math.abs(d1 - d2) < 0.0001, 'Distance should be symmetric');
  });
});

// ---------------------------------------------------------------------------
// isInZone
// ---------------------------------------------------------------------------
describe('isInZone', () => {
  const testZone = { latMin: 1.0, latMax: 2.0, lonMin: 103.0, lonMax: 104.0 };

  it('returns true for point inside zone', () => {
    assert.equal(isInZone(1.5, 103.5, testZone), true);
  });

  it('returns true for point on boundary', () => {
    assert.equal(isInZone(1.0, 103.0, testZone), true);
    assert.equal(isInZone(2.0, 104.0, testZone), true);
  });

  it('returns false for point outside zone', () => {
    assert.equal(isInZone(0.5, 103.5, testZone), false);
    assert.equal(isInZone(1.5, 102.5, testZone), false);
    assert.equal(isInZone(2.5, 103.5, testZone), false);
    assert.equal(isInZone(1.5, 104.5, testZone), false);
  });
});

// ---------------------------------------------------------------------------
// isInAnchorageOrTSS
// ---------------------------------------------------------------------------
describe('isInAnchorageOrTSS', () => {
  it('detects point inside SG Anchorage', () => {
    // ZONES.anchorage: lonMin:103.72, lonMax:103.82, latMin:1.17, latMax:1.22
    assert.equal(isInAnchorageOrTSS(1.19, 103.77), true);
  });

  it('detects point inside TSS lane', () => {
    // ZONES.tss: lonMin:103.45, lonMax:104.40, latMin:1.13, latMax:1.26
    assert.equal(isInAnchorageOrTSS(1.18, 103.80), true);
  });

  it('returns false for open water', () => {
    // lat 1.50 is outside TSS latMax 1.26, so this should be false
    assert.equal(isInAnchorageOrTSS(1.50, 103.50), false);
  });
});

// ---------------------------------------------------------------------------
// isInTSS
// ---------------------------------------------------------------------------
describe('isInTSS', () => {
  it('returns true for point inside TSS', () => {
    // ZONES.tss: latMin:1.13, latMax:1.26 — 1.14 is inside
    assert.equal(isInTSS(1.14, 103.80), true);
  });

  it('returns false for point outside TSS', () => {
    // lat 1.50 is outside latMax 1.26
    assert.equal(isInTSS(1.50, 103.80), false);
  });
});

// ---------------------------------------------------------------------------
// runAnomalyChecks — with mock DB data
// ---------------------------------------------------------------------------
describe('runAnomalyChecks', () => {
  it('detects speed anomaly for fast vessels in zone', () => {
    // Insert a vessel travelling at 35 kt (above 30 kt threshold) INSIDE TSS zone
    // TSS: latMin:1.13, latMax:1.26, lonMin:103.45, lonMax:104.40
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('FAST00001', 1.20, 103.80, 35, 180, 'MV Speedy');

    const anomalies = runAnomalyChecks(db);
    const speedAnomaly = anomalies.find(
      (a) => a.mmsi === 'FAST00001' && a.type === 'speed_violation'
    );
    assert.ok(speedAnomaly, 'Should detect speed violation');
    assert.equal(speedAnomaly.speed_kt, 35);
  });

  it('does not flag vessels below speed threshold', () => {
    // 10 kt is below the 30 kt threshold
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('SLOW00001', 1.20, 103.80, 10, 90, 'MV Steady');

    const anomalies = runAnomalyChecks(db);
    const speedAnomaly = anomalies.find((a) => a.mmsi === 'SLOW00001' && a.type === 'speed_violation');
    assert.ok(!speedAnomaly, 'Should not flag normal speed vessel');
  });

  it('dedup — same anomaly does not create duplicate DB alert', () => {
    // The first test already created an alert for FAST00001 via insertAlert.
    // Insert another fast reading for the same vessel inside the zone.
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('FAST00001', 1.20, 103.81, 32, 180, 'MV Speedy');

    // Count alerts before
    const countBefore = db.prepare(
      "SELECT COUNT(*) AS cnt FROM alerts WHERE title = 'Speed threshold violation' AND entity_mmsi = 'FAST00001'"
    ).get().cnt;

    runAnomalyChecks(db);

    // Count alerts after — should not have increased (dedup suppresses DB insert)
    const countAfter = db.prepare(
      "SELECT COUNT(*) AS cnt FROM alerts WHERE title = 'Speed threshold violation' AND entity_mmsi = 'FAST00001'"
    ).get().cnt;

    assert.equal(countAfter, countBefore, 'Duplicate alert should not be inserted into DB');
  });
});
