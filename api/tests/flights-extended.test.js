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
// Flights API — extended tests
// ---------------------------------------------------------------------------
describe('Flights API — extended', () => {
  it('GET /api/flights returns 200 with array', async () => {
    const res = await request(app).get('/api/flights');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('POST /api/flights with valid data returns 201', async () => {
    const flight = {
      callsign: 'TGR781',
      squawk: '1234',
      lat: 1.40,
      lon: 103.95,
      altitude_ft: 28000,
      speed_kt: 380,
      heading: 270,
    };

    const res = await request(app).post('/api/flights').send(flight);
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
  });

  it('GET /api/flights returns deduplicated latest positions', async () => {
    // Insert two positions for the same callsign with different timestamps
    const db = getDb();
    db.prepare(
      "INSERT INTO flights (callsign, squawk, lat, lon, altitude_ft, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-30 seconds'))"
    ).run('SIA456', '2345', 1.35, 103.90, 35000, 450, 90);
    db.prepare(
      "INSERT INTO flights (callsign, squawk, lat, lon, altitude_ft, speed_kt, heading, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-15 seconds'))"
    ).run('SIA456', '2345', 1.36, 103.91, 34500, 445, 91);

    const res = await request(app).get('/api/flights');
    assert.equal(res.status, 200);

    // Should only have one entry per callsign (deduplicated)
    const entries = res.body.filter((f) => f.callsign === 'SIA456');
    assert.equal(entries.length, 1, 'Should have exactly one entry per callsign (deduped)');
    // Latest position
    assert.equal(entries[0].lat, 1.36);
  });

  it('POST /api/flights with squawk 7700 (emergency) is accepted', async () => {
    const res = await request(app).post('/api/flights').send({
      callsign: 'EMG001',
      squawk: '7700',
      lat: 1.30,
      lon: 103.80,
      altitude_ft: 5000,
      speed_kt: 200,
      heading: 180,
    });
    assert.equal(res.status, 201);

    // Verify the squawk is stored correctly
    const getRes = await request(app).get('/api/flights');
    const found = getRes.body.find((f) => f.callsign === 'EMG001');
    assert.ok(found);
    assert.equal(found.squawk, '7700');
  });

  it('POST /api/flights with squawk 7500 (hijack) is accepted', async () => {
    const res = await request(app).post('/api/flights').send({
      callsign: 'HJK001',
      squawk: '7500',
      lat: 1.31,
      lon: 103.81,
      altitude_ft: 10000,
      speed_kt: 300,
      heading: 90,
    });
    assert.equal(res.status, 201);
  });

  it('POST /api/flights without callsign returns 400 (callsign required)', async () => {
    // callsign is required by validation middleware
    const res = await request(app).post('/api/flights').send({
      lat: 1.40,
      lon: 104.00,
      altitude_ft: 20000,
    });
    assert.equal(res.status, 400, 'Should return 400 when callsign is missing');
  });

  it('POST /api/flights with squawk 7600 (comms failure) is accepted', async () => {
    const res = await request(app).post('/api/flights').send({
      callsign: 'COM001',
      squawk: '7600',
      lat: 1.28,
      lon: 103.78,
      altitude_ft: 15000,
      speed_kt: 250,
      heading: 45,
    });
    assert.equal(res.status, 201);

    const getRes = await request(app).get('/api/flights');
    const found = getRes.body.find((f) => f.callsign === 'COM001');
    assert.ok(found);
    assert.equal(found.squawk, '7600');
  });
});
