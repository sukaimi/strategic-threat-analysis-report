'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

const {
  checkGeofence,
  isInApproachZone,
  SG_APPROACH_CENTER,
  SG_APPROACH_RADIUS_NM,
} = require('../src/services/geofence');

let db;

before(() => {
  close();
  db = getDb(':memory:');
});

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// isInApproachZone
// ---------------------------------------------------------------------------
describe('isInApproachZone', () => {
  it('returns true for Singapore center', () => {
    assert.equal(isInApproachZone(SG_APPROACH_CENTER.lat, SG_APPROACH_CENTER.lon), true);
  });

  it('returns true for point within 50 NM of center', () => {
    // ~10 NM south of center
    assert.equal(isInApproachZone(1.13, 103.82), true);
  });

  it('returns false for point well outside 50 NM radius', () => {
    // Roughly 120 NM away
    assert.equal(isInApproachZone(3.0, 106.0), false);
  });
});

// ---------------------------------------------------------------------------
// checkGeofence
// ---------------------------------------------------------------------------
describe('checkGeofence', () => {
  it('triggers alert for flagged vessel inside approach zone', () => {
    const vessels = [
      { mmsi: '999000001', lat: 1.29, lon: 103.85, vessel_name: 'MV Suspect', flagged: 1 },
    ];

    const triggered = checkGeofence(vessels, db);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].mmsi, '999000001');
    assert.equal(triggered[0].vessel_name, 'MV Suspect');

    // Verify alert was inserted into DB
    const alert = db.prepare(
      "SELECT * FROM alerts WHERE entity_mmsi = '999000001' AND title = 'Sanctioned vessel entering approach zone'"
    ).get();
    assert.ok(alert, 'Alert should be in the database');
    assert.equal(alert.severity, 'CRITICAL');
  });

  it('does not trigger for non-flagged vessel', () => {
    const vessels = [
      { mmsi: '999000002', lat: 1.29, lon: 103.85, vessel_name: 'MV Normal', flagged: 0 },
    ];

    const triggered = checkGeofence(vessels, db);
    assert.equal(triggered.length, 0);
  });

  it('does not trigger for flagged vessel outside zone', () => {
    const vessels = [
      { mmsi: '999000003', lat: 5.0, lon: 110.0, vessel_name: 'MV FarAway', flagged: 1 },
    ];

    const triggered = checkGeofence(vessels, db);
    assert.equal(triggered.length, 0);
  });

  it('deduplicates alerts within 30-minute window', () => {
    const vessels = [
      { mmsi: '999000001', lat: 1.29, lon: 103.85, vessel_name: 'MV Suspect', flagged: 1 },
    ];

    const countBefore = db.prepare(
      "SELECT COUNT(*) AS cnt FROM alerts WHERE entity_mmsi = '999000001' AND title = 'Sanctioned vessel entering approach zone'"
    ).get().cnt;

    checkGeofence(vessels, db);

    const countAfter = db.prepare(
      "SELECT COUNT(*) AS cnt FROM alerts WHERE entity_mmsi = '999000001' AND title = 'Sanctioned vessel entering approach zone'"
    ).get().cnt;

    assert.equal(countAfter, countBefore, 'Should not insert duplicate alert');
  });

  it('skips vessels with null lat/lon', () => {
    const vessels = [
      { mmsi: '999000004', lat: null, lon: null, vessel_name: 'MV NoPos', flagged: 1 },
    ];

    const triggered = checkGeofence(vessels, db);
    assert.equal(triggered.length, 0);
  });
});
