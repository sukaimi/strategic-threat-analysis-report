'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// We need to isolate each test run with its own in-memory DB.
// The module caches the singleton, so we manipulate env + require fresh or
// call getDb(':memory:') before any other call.

// Because db.js uses a module-level singleton, we point it at :memory: via
// the first getDb() call (passing the path argument).

const { getDb, close, purge72h } = require('../src/db');

describe('SQLite database module', () => {
  let db;

  before(() => {
    db = getDb(':memory:');
  });

  after(() => {
    close();
  });

  it('initializes without error', () => {
    assert.ok(db, 'db instance should be truthy');
  });

  it('all expected tables exist', () => {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = rows.map((r) => r.name);

    for (const table of ['vessels', 'flights', 'weather', 'port_status', 'ai_analyses', 'alerts']) {
      assert.ok(names.includes(table), `table "${table}" should exist`);
    }
  });

  it('can insert and query a vessel', () => {
    db.prepare(
      'INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('123456789', 1.35, 103.82, 12.5, 180, 'MV Test', 'cargo');

    const row = db.prepare('SELECT * FROM vessels WHERE mmsi = ?').get('123456789');
    assert.equal(row.mmsi, '123456789');
    assert.equal(row.lat, 1.35);
    assert.equal(row.vessel_name, 'MV Test');
    assert.equal(row.flagged, 0);
  });

  it('can insert and query a flight', () => {
    db.prepare(
      'INSERT INTO flights (callsign, squawk, lat, lon, altitude_ft, speed_kt, heading) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('SIA321', '7700', 1.4, 103.9, 35000, 450, 90);

    const row = db.prepare('SELECT * FROM flights WHERE callsign = ?').get('SIA321');
    assert.equal(row.callsign, 'SIA321');
    assert.equal(row.squawk, '7700');
    assert.equal(row.altitude_ft, 35000);
  });

  it('can insert and query weather', () => {
    db.prepare(
      'INSERT INTO weather (cb_cells, wind_speed_kt, wind_dir, visibility_km, sea_state) VALUES (?, ?, ?, ?, ?)'
    ).run(3, 25.0, 220, 8.5, 'moderate');

    const row = db.prepare('SELECT * FROM weather WHERE id = 1').get();
    assert.equal(row.cb_cells, 3);
    assert.equal(row.wind_speed_kt, 25.0);
    assert.equal(row.sea_state, 'moderate');
  });

  it('can insert and query port_status', () => {
    db.prepare(
      'INSERT INTO port_status (vessels_queued, berth_utilisation, channel_flow_pct) VALUES (?, ?, ?)'
    ).run(12, 0.78, 65.3);

    const row = db.prepare('SELECT * FROM port_status WHERE id = 1').get();
    assert.equal(row.vessels_queued, 12);
    assert.equal(row.berth_utilisation, 0.78);
  });

  it('can insert and query ai_analyses', () => {
    db.prepare(
      'INSERT INTO ai_analyses (composite_score, threat_json, tactical_brief) VALUES (?, ?, ?)'
    ).run(0.85, '{"threats":[]}', 'All clear in sector 7');

    const row = db.prepare('SELECT * FROM ai_analyses WHERE id = 1').get();
    assert.equal(row.composite_score, 0.85);
    assert.equal(row.tactical_brief, 'All clear in sector 7');
  });

  it('can insert and query alerts', () => {
    db.prepare(
      'INSERT INTO alerts (severity, title, description, entity_mmsi, entity_callsign) VALUES (?, ?, ?, ?, ?)'
    ).run('HIGH', 'AIS Dark Vessel', 'Vessel went dark near strait', '987654321', null);

    const row = db.prepare('SELECT * FROM alerts WHERE entity_mmsi = ?').get('987654321');
    assert.equal(row.severity, 'HIGH');
    assert.equal(row.title, 'AIS Dark Vessel');
    assert.equal(row.acknowledged, 0);
    assert.equal(row.flagged, 0);
  });

  it('purge72h removes old records but keeps recent ones', () => {
    // Insert an old vessel record (96 hours ago)
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, recorded_at) VALUES (?, ?, ?, datetime('now', '-96 hours'))"
    ).run('OLD_VESSEL', 1.0, 103.0);

    // Insert an old flight record
    db.prepare(
      "INSERT INTO flights (callsign, lat, lon, recorded_at) VALUES (?, ?, ?, datetime('now', '-96 hours'))"
    ).run('OLD_FLT', 1.0, 103.0);

    // Insert an old weather record
    db.prepare(
      "INSERT INTO weather (cb_cells, recorded_at) VALUES (?, datetime('now', '-96 hours'))"
    ).run(0);

    // Insert an old port_status record
    db.prepare(
      "INSERT INTO port_status (vessels_queued, recorded_at) VALUES (?, datetime('now', '-96 hours'))"
    ).run(0);

    // Count before purge
    const vesselsBefore = db.prepare('SELECT COUNT(*) AS c FROM vessels').get().c;
    const flightsBefore = db.prepare('SELECT COUNT(*) AS c FROM flights').get().c;

    const result = purge72h();

    // Old records should have been deleted
    assert.ok(result.vessels >= 1, 'should purge at least 1 old vessel');
    assert.ok(result.flights >= 1, 'should purge at least 1 old flight');
    assert.ok(result.weather >= 1, 'should purge at least 1 old weather');
    assert.ok(result.port_status >= 1, 'should purge at least 1 old port_status');

    // Recent vessel (inserted earlier in tests) should still exist
    const recent = db.prepare('SELECT * FROM vessels WHERE mmsi = ?').get('123456789');
    assert.ok(recent, 'recent vessel should survive purge');
  });
});
