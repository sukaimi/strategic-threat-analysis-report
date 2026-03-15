'use strict';

// Clear API_KEY before any module loads config (dev mode — auth skipped)
process.env.API_KEY = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { getDb, close } = require('../src/db');

// Invalidate config cache so it picks up the empty API_KEY
delete require.cache[require.resolve('../src/config')];

before(() => {
  close();
  getDb(':memory:');
});

const app = require('../src/app');

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// Vessels API — extended tests
// ---------------------------------------------------------------------------
describe('Vessels API — extended', () => {
  it('GET /api/vessels returns 200 with array', async () => {
    const res = await request(app).get('/api/vessels');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('POST /api/vessels with valid MMSI returns 201', async () => {
    const vessel = {
      mmsi: '234567890',
      lat: 1.30,
      lon: 103.80,
      speed_kt: 8.0,
      heading: 270,
      vessel_name: 'MV Regression',
      vessel_type: 'tanker',
    };

    const res = await request(app).post('/api/vessels').send(vessel);
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
  });

  it('GET /api/vessels returns the inserted vessel (deduplicated)', async () => {
    // Insert two positions for the same MMSI with different timestamps
    const db = getDb();
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 minutes'))"
    ).run('345678901', 1.31, 103.81, 5.0, 90, 'MV Dedup', 'cargo');
    db.prepare(
      "INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 minutes'))"
    ).run('345678901', 1.32, 103.82, 6.0, 91, 'MV Dedup', 'cargo');

    const res = await request(app).get('/api/vessels');
    assert.equal(res.status, 200);

    // Should only have one entry per MMSI (deduplicated — latest position)
    const entries = res.body.filter((v) => v.mmsi === '345678901');
    assert.equal(entries.length, 1, 'Should have exactly one entry per MMSI (deduped)');
    // Latest position should be the second insert
    assert.equal(entries[0].lat, 1.32);
  });

  it('POST /api/vessels accepts minimal data (only mmsi required by schema)', async () => {
    const res = await request(app).post('/api/vessels').send({
      mmsi: '456789012',
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
  });

  it('POST /api/vessels with numeric fields works correctly', async () => {
    const res = await request(app).post('/api/vessels').send({
      mmsi: '567890123',
      lat: -1.5,
      lon: 103.0,
      speed_kt: 0,
      heading: 360,
    });
    assert.equal(res.status, 201);
  });
});
