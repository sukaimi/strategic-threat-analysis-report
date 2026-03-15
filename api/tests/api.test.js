'use strict';

// Clear API_KEY before any module loads config (dev mode — auth skipped)
process.env.API_KEY = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { getDb, close } = require('../src/db');

// Invalidate config cache so it picks up the empty API_KEY
delete require.cache[require.resolve('../src/config')];

// Initialise in-memory SQLite before loading app
before(() => {
  close();
  getDb(':memory:');
});

const app = require('../src/app');

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// Vessels
// ---------------------------------------------------------------------------
describe('Vessels API', () => {
  it('GET /api/vessels returns 200 with array', async () => {
    const res = await request(app).get('/api/vessels');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('POST /api/vessels inserts and GET retrieves it', async () => {
    const vessel = {
      mmsi: '123456789',
      lat: 1.29,
      lon: 103.85,
      speed_kt: 12.5,
      heading: 180,
      vessel_name: 'MV Test',
      vessel_type: 'cargo',
    };
    const postRes = await request(app).post('/api/vessels').send(vessel);
    assert.equal(postRes.status, 201);
    assert.ok(postRes.body.id);

    const getRes = await request(app).get('/api/vessels');
    assert.equal(getRes.status, 200);
    const found = getRes.body.find((v) => v.mmsi === '123456789');
    assert.ok(found, 'Inserted vessel should appear in GET results');
    assert.equal(found.vessel_name, 'MV Test');
  });
});

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------
describe('Flights API', () => {
  it('GET /api/flights returns 200', async () => {
    const res = await request(app).get('/api/flights');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('POST /api/flights inserts and GET retrieves it', async () => {
    const flight = {
      callsign: 'SIA123',
      squawk: '7700',
      lat: 1.35,
      lon: 103.99,
      altitude_ft: 35000,
      speed_kt: 450,
      heading: 90,
    };
    const postRes = await request(app).post('/api/flights').send(flight);
    assert.equal(postRes.status, 201);
    assert.ok(postRes.body.id);

    const getRes = await request(app).get('/api/flights');
    assert.equal(getRes.status, 200);
    const found = getRes.body.find((f) => f.callsign === 'SIA123');
    assert.ok(found, 'Inserted flight should appear in GET results');
  });
});

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------
describe('Weather API', () => {
  it('GET /api/weather returns 200', async () => {
    const res = await request(app).get('/api/weather');
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------
describe('Port API', () => {
  it('GET /api/port returns 200', async () => {
    const res = await request(app).get('/api/port');
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
describe('Alerts API', () => {
  it('POST creates alert, GET retrieves, PATCH acknowledges', async () => {
    const alert = {
      severity: 'HIGH',
      title: 'Test Alert',
      description: 'Suspicious AIS gap detected',
      entity_mmsi: '123456789',
    };

    // Create
    const postRes = await request(app).post('/api/alerts').send(alert);
    assert.equal(postRes.status, 201);
    const alertId = postRes.body.id;
    assert.ok(alertId);

    // Retrieve unacknowledged
    const getRes = await request(app).get('/api/alerts');
    assert.equal(getRes.status, 200);
    const found = getRes.body.find((a) => Number(a.id) === Number(alertId));
    assert.ok(found, 'Alert should appear in unacknowledged list');
    assert.equal(found.acknowledged, 0);

    // Acknowledge
    const patchRes = await request(app).patch(`/api/alerts/${alertId}/acknowledge`);
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.acknowledged, true);

    // Verify no longer in unacknowledged list
    const getRes2 = await request(app).get('/api/alerts');
    const stillThere = getRes2.body.find((a) => Number(a.id) === Number(alertId));
    assert.ok(!stillThere, 'Acknowledged alert should not appear in unacknowledged list');
  });
});

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------
describe('Analyses API', () => {
  it('GET /api/analyses returns 200', async () => {
    const res = await request(app).get('/api/analyses');
    assert.equal(res.status, 200);
  });

  it('POST then GET /api/analyses returns the inserted analysis', async () => {
    const analysis = {
      composite_score: 42,
      threat_json: JSON.stringify({ composite_score: 42, threat_level: 'MEDIUM' }),
      tactical_brief: 'Test tactical brief',
    };
    const postRes = await request(app).post('/api/analyses').send(analysis);
    assert.equal(postRes.status, 201);
    assert.ok(postRes.body.id);

    const getRes = await request(app).get('/api/analyses');
    assert.equal(getRes.status, 200);
    assert.ok(getRes.body, 'Should return the latest analysis');
    assert.equal(getRes.body.composite_score, 42);
  });

  it('GET /api/analyses?theater=merlion returns same data as GET /api/analyses', async () => {
    const res = await request(app).get('/api/analyses?theater=merlion');
    assert.equal(res.status, 200);
    assert.ok(res.body, 'Should return analysis for merlion theater');
    assert.equal(res.body.composite_score, 42);
  });

  it('GET /api/analyses/count returns the analysis count', async () => {
    const res = await request(app).get('/api/analyses/count');
    assert.equal(res.status, 200);
    assert.ok(res.body.count >= 1, 'Count should be at least 1');
  });

  it('GET /api/analyses/history returns array', async () => {
    const res = await request(app).get('/api/analyses/history');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1, 'History should have at least 1 entry');
  });
});
