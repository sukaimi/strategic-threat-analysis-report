'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

const {
  haversineNm,
  isInZone,
  calculateCPA,
  getSpeedThreshold,
  checkCollisionRisk,
  checkWrongWayTSS,
  checkMMSIDuplication,
  checkAISSpoofingPatterns,
  runAnomalyChecks,
  ZONES,
  TSS_EASTBOUND,
  TSS_WESTBOUND,
  SPEED_THRESHOLDS,
  DARK_TIERS,
  POSITION_JUMP_NM,
  SINGAPORE_LAND,
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
// C1: Position jump threshold
// ---------------------------------------------------------------------------
describe('C1 — position jump threshold', () => {
  it('POSITION_JUMP_NM is 8', () => {
    assert.equal(POSITION_JUMP_NM, 8);
  });
});

// ---------------------------------------------------------------------------
// C4: Vessel-type-aware speed thresholds
// ---------------------------------------------------------------------------
describe('C4 — vessel-type speed thresholds', () => {
  it('returns 18 for tanker', () => {
    assert.equal(getSpeedThreshold('Tanker'), 18);
  });

  it('returns 18 for bulk carrier', () => {
    assert.equal(getSpeedThreshold('Bulk carrier'), 18);
  });

  it('returns 25 for container', () => {
    assert.equal(getSpeedThreshold('Container'), 25);
  });

  it('returns 40 for passenger', () => {
    assert.equal(getSpeedThreshold('Passenger'), 40);
  });

  it('returns 40 for ferry', () => {
    assert.equal(getSpeedThreshold('Passenger/Ferry'), 40);
  });

  it('returns 12 for fishing', () => {
    assert.equal(getSpeedThreshold('Fishing'), 12);
  });

  it('returns 30 for null/unknown', () => {
    assert.equal(getSpeedThreshold(null), 30);
    assert.equal(getSpeedThreshold('Other'), 30);
  });

  it('detects tanker exceeding 18kt in zone', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('TANKER001', 1.20, 103.80, 20, 270, 'MV Slow Tanker', 'Tanker');

    const anomalies = runAnomalyChecks(db);
    const speedAnomaly = anomalies.find(
      (a) => a.mmsi === 'TANKER001' && a.type === 'speed_violation'
    );
    assert.ok(speedAnomaly, 'Should detect tanker speeding at 20kt (limit 18kt)');
  });
});

// ---------------------------------------------------------------------------
// H1: CPA collision risk
// ---------------------------------------------------------------------------
describe('H1 — CPA collision risk', () => {
  it('calculateCPA returns valid result for converging vessels', () => {
    const a = { lat: 1.20, lon: 103.80, speed_kt: 12, heading: 90 };
    const b = { lat: 1.20, lon: 103.82, speed_kt: 12, heading: 270 };
    const result = calculateCPA(a, b);
    assert.ok(result, 'Should return CPA result');
    assert.ok(result.cpa >= 0, 'CPA should be non-negative');
    assert.ok(result.tcpa > 0, 'TCPA should be positive for converging vessels');
  });

  it('calculateCPA returns null for parallel vessels', () => {
    const a = { lat: 1.20, lon: 103.80, speed_kt: 12, heading: 90 };
    const b = { lat: 1.21, lon: 103.80, speed_kt: 12, heading: 90 };
    const result = calculateCPA(a, b);
    assert.equal(result, null, 'Parallel vessels should return null');
  });

  it('detects collision risk for head-on vessels', () => {
    // Two vessels heading towards each other very close
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('CPA_A001', 1.15, 103.80, 15, 90, 'Vessel A');
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('CPA_B001', 1.15, 103.81, 15, 270, 'Vessel B');

    const anomalies = checkCollisionRisk(db);
    const collision = anomalies.find(a => a.type === 'collision_risk');
    assert.ok(collision, 'Should detect collision risk for head-on vessels');
  });
});

// ---------------------------------------------------------------------------
// H2: Wrong-way TSS
// ---------------------------------------------------------------------------
describe('H2 — wrong-way TSS detection', () => {
  it('TSS lane zones are defined correctly', () => {
    assert.ok(TSS_EASTBOUND.latMin < TSS_EASTBOUND.latMax);
    assert.ok(TSS_WESTBOUND.latMin < TSS_WESTBOUND.latMax);
    assert.ok(TSS_EASTBOUND.latMax <= TSS_WESTBOUND.latMin, 'Eastbound south of westbound');
  });

  it('flags vessel heading west in eastbound lane', () => {
    // Eastbound lane: heading should be 45-135
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('WRONG001', 1.16, 103.80, 10, 250, 'Wrong Way');

    const anomalies = checkWrongWayTSS(db);
    const wrongWay = anomalies.find(a => a.mmsi === 'WRONG001');
    assert.ok(wrongWay, 'Should flag vessel heading 250 in eastbound lane');
    assert.equal(wrongWay.lane, 'eastbound');
  });

  it('flags vessel heading east in westbound lane', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('WRONG002', 1.23, 103.80, 10, 90, 'Wrong Way 2');

    const anomalies = checkWrongWayTSS(db);
    const wrongWay = anomalies.find(a => a.mmsi === 'WRONG002');
    assert.ok(wrongWay, 'Should flag vessel heading 90 in westbound lane');
    assert.equal(wrongWay.lane, 'westbound');
  });
});

// ---------------------------------------------------------------------------
// H7: MMSI duplication
// ---------------------------------------------------------------------------
describe('H7 — MMSI duplication detection', () => {
  it('flags same MMSI at two distant positions', () => {
    // Insert two records for same MMSI at positions >5NM apart, close in time
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('DUP00001', 1.20, 103.50, 10, 90, now);
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('DUP00001', 1.20, 104.00, 10, 270, now);

    const anomalies = checkMMSIDuplication(db);
    const dup = anomalies.find(a => a.mmsi === 'DUP00001');
    assert.ok(dup, 'Should detect MMSI duplication');
    assert.ok(dup.distance_nm > 5, 'Distance should be >5NM');
  });
});

// ---------------------------------------------------------------------------
// H9: Tiered AIS dark
// ---------------------------------------------------------------------------
describe('H9 — tiered AIS dark thresholds', () => {
  it('DARK_TIERS are defined in descending order', () => {
    assert.equal(DARK_TIERS.length, 3);
    assert.equal(DARK_TIERS[0].minutesSilent, 120);
    assert.equal(DARK_TIERS[0].severity, 'CRITICAL');
    assert.equal(DARK_TIERS[1].minutesSilent, 60);
    assert.equal(DARK_TIERS[1].severity, 'HIGH');
    assert.equal(DARK_TIERS[2].minutesSilent, 30);
    assert.equal(DARK_TIERS[2].severity, 'MEDIUM');
  });

  it('generates MEDIUM alert for 35-min dark vessel', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-35 minutes'))"
    ).run('DARK0035', 1.20, 103.80, 10, 90);

    const anomalies = runAnomalyChecks(db);
    const dark = anomalies.find(a => a.mmsi === 'DARK0035' && a.type === 'ais_dark');
    assert.ok(dark, 'Should detect 35-min dark period');
    assert.equal(dark.severity, 'MEDIUM');
  });

  it('generates HIGH alert for 65-min dark vessel', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-65 minutes'))"
    ).run('DARK0065', 1.20, 103.80, 10, 90);

    const anomalies = runAnomalyChecks(db);
    const dark = anomalies.find(a => a.mmsi === 'DARK0065' && a.type === 'ais_dark');
    assert.ok(dark, 'Should detect 65-min dark period');
    assert.equal(dark.severity, 'HIGH');
  });

  it('generates CRITICAL alert for 125-min dark vessel', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-125 minutes'))"
    ).run('DARK0125', 1.20, 103.80, 10, 90);

    const anomalies = runAnomalyChecks(db);
    const dark = anomalies.find(a => a.mmsi === 'DARK0125' && a.type === 'ais_dark');
    assert.ok(dark, 'Should detect 125-min dark period');
    assert.equal(dark.severity, 'CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// M10: AIS spoofing patterns
// ---------------------------------------------------------------------------
describe('M10 — AIS spoofing patterns', () => {
  it('detects position on land (Singapore island)', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('LAND0001', 1.35, 103.85, 10, 90);

    const anomalies = checkAISSpoofingPatterns(db);
    const onLand = anomalies.find(a => a.mmsi === 'LAND0001' && a.type === 'position_on_land');
    assert.ok(onLand, 'Should detect position on land');
  });

  it('does NOT flag position in water', () => {
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('WATER001', 1.15, 103.80, 10, 90);

    const anomalies = checkAISSpoofingPatterns(db);
    const onLand = anomalies.find(a => a.mmsi === 'WATER001' && a.type === 'position_on_land');
    assert.ok(!onLand, 'Should NOT flag vessel in water');
  });

  it('detects speed/position mismatch — zero speed but moved', () => {
    // Two readings, zero speed but different positions
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-2 minutes'))"
    ).run('SPOOF001', 1.15, 103.80, 0, 90);
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('SPOOF001', 1.17, 103.82, 0, 90);

    const anomalies = checkAISSpoofingPatterns(db);
    const mismatch = anomalies.find(a => a.mmsi === 'SPOOF001' && a.type === 'speed_position_mismatch');
    assert.ok(mismatch, 'Should detect speed/position mismatch');
  });
});

// ---------------------------------------------------------------------------
// SINGAPORE_LAND bounds
// ---------------------------------------------------------------------------
describe('SINGAPORE_LAND bounds', () => {
  it('covers Singapore island area', () => {
    assert.ok(SINGAPORE_LAND.latMin > 1.2);
    assert.ok(SINGAPORE_LAND.latMax < 1.5);
    assert.ok(SINGAPORE_LAND.lonMin > 103.5);
    assert.ok(SINGAPORE_LAND.lonMax < 104.2);
  });
});
