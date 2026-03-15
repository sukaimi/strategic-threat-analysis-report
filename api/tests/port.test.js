'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

// Initialise in-memory DB before importing the collector so the singleton is set
let db;

describe('Port status collector', () => {
  let derivePortMetrics, getStats;

  before(() => {
    db = getDb(':memory:');
    // Now safe to load — it will use the already-initialised in-memory DB
    const port = require('../src/collectors/port');
    derivePortMetrics = port.derivePortMetrics;
    getStats = port.getStats;
  });

  after(() => {
    close();
  });

  it('derivePortMetrics correctly calculates vessels_queued from vessel positions', () => {
    // Insert vessels with speed < 2kt in Singapore anchorage
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('111000001', 1.2, 103.8, 0.5, 90);
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('111000002', 1.15, 103.7, 1.5, 180);
    // Vessel outside anchorage — should NOT count
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('111000003', 2.0, 105.0, 0.3, 0);
    // Vessel too fast — should NOT count as queued
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run('111000004', 1.25, 103.9, 10.0, 270);

    const metrics = derivePortMetrics(db);
    assert.equal(metrics.vessels_queued, 2, 'should count only slow vessels in anchorage');
  });

  it('berth_utilisation calculation is bounded 0-1', () => {
    // Already have some vessels from previous test — result should be between 0 and 1
    const metrics = derivePortMetrics(db);
    assert.ok(metrics.berth_utilisation >= 0, 'berth_utilisation should be >= 0');
    assert.ok(metrics.berth_utilisation <= 1, 'berth_utilisation should be <= 1');
  });

  it('berth_utilisation does not exceed 1 even with many vessels', () => {
    // Insert 70 berthed vessels (more than capacity of 60)
    const stmt = db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    );
    for (let i = 0; i < 70; i++) {
      stmt.run(`BERTH_${String(i).padStart(3, '0')}`, 1.2, 103.8, 0.1, 0);
    }

    const metrics = derivePortMetrics(db);
    assert.ok(metrics.berth_utilisation <= 1, 'berth_utilisation must be clamped to 1');
    assert.equal(metrics.berth_utilisation, 1, 'should be exactly 1 when over capacity');
  });

  it('channel_flow_pct calculation is bounded 0-100', () => {
    const metrics = derivePortMetrics(db);
    assert.ok(metrics.channel_flow_pct >= 0, 'channel_flow_pct should be >= 0');
    assert.ok(metrics.channel_flow_pct <= 100, 'channel_flow_pct should be <= 100');
  });

  it('handles empty vessel data gracefully', () => {
    // Use a fresh in-memory DB with no vessel records
    const Database = require('better-sqlite3');
    const emptyDb = new Database(':memory:');
    emptyDb.exec(`
      CREATE TABLE vessels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mmsi TEXT NOT NULL,
        lat REAL, lon REAL,
        speed_kt REAL, heading REAL,
        vessel_name TEXT, vessel_type TEXT,
        flagged INTEGER DEFAULT 0,
        recorded_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const metrics = derivePortMetrics(emptyDb);
    assert.equal(metrics.vessels_queued, 0);
    assert.equal(metrics.berth_utilisation, 0);
    assert.equal(metrics.channel_flow_pct, 0);
    emptyDb.close();
  });

  it('getStats returns correct structure', () => {
    const stats = getStats();
    assert.ok('lastFetchAt' in stats, 'should have lastFetchAt');
    assert.ok('lastSuccessAt' in stats, 'should have lastSuccessAt');
    assert.ok('fetchCount' in stats, 'should have fetchCount');
    assert.ok('errorCount' in stats, 'should have errorCount');
    assert.ok('running' in stats, 'should have running');
    assert.equal(typeof stats.fetchCount, 'number');
    assert.equal(typeof stats.errorCount, 'number');
    assert.equal(typeof stats.running, 'boolean');
  });
});
