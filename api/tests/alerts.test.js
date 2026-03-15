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
// Alerts API
// ---------------------------------------------------------------------------
describe('Alerts API — extended', () => {
  it('GET /api/alerts returns 200 with array', async () => {
    const res = await request(app).get('/api/alerts');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('POST /api/alerts creates alert with valid data', async () => {
    const alert = {
      severity: 'HIGH',
      title: 'Suspicious vessel near anchorage',
      description: 'Vessel MMSI 999888777 loitering near Eastern Anchorage',
      entity_mmsi: '999888777',
    };

    const res = await request(app).post('/api/alerts').send(alert);
    assert.equal(res.status, 201);
    assert.ok(res.body.id, 'Should return alert id');
  });

  it('GET /api/alerts returns the created alert', async () => {
    const res = await request(app).get('/api/alerts');
    assert.equal(res.status, 200);
    const found = res.body.find((a) => a.entity_mmsi === '999888777');
    assert.ok(found, 'Created alert should appear in list');
    assert.equal(found.severity, 'HIGH');
    assert.equal(found.acknowledged, 0);
  });

  it('GET /api/alerts/all returns alerts from last 72 hours', async () => {
    const res = await request(app).get('/api/alerts/all');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1, 'Should include at least the previously created alert');
  });

  it('POST /api/alerts with missing severity returns 400 (validation)', async () => {
    const res = await request(app).post('/api/alerts').send({
      title: 'No severity',
      description: 'Missing severity field',
    });
    assert.equal(res.status, 400, 'Should return 400 for missing required severity');
    assert.ok(res.body.error, 'Should include error message');
  });

  it('POST /api/alerts with invalid severity returns 400', async () => {
    const res = await request(app).post('/api/alerts').send({
      severity: 'INVALID',
      title: 'Bad severity',
    });
    assert.equal(res.status, 400, 'Should return 400 for invalid severity');
  });

  it('PATCH /api/alerts/:id/acknowledge — marks alert as acknowledged', async () => {
    // Create an alert first
    const postRes = await request(app).post('/api/alerts').send({
      severity: 'MEDIUM',
      title: 'To be acknowledged',
      description: 'Test ack flow',
    });
    const alertId = postRes.body.id;

    const patchRes = await request(app).patch(`/api/alerts/${alertId}/acknowledge`);
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.acknowledged, true);

    // Should no longer appear in unacknowledged list
    const getRes = await request(app).get('/api/alerts');
    const found = getRes.body.find((a) => Number(a.id) === Number(alertId));
    assert.ok(!found, 'Acknowledged alert should not appear in unacknowledged list');
  });

  it('PATCH /api/alerts/99999/acknowledge — returns 404 for non-existent alert', async () => {
    const res = await request(app).patch('/api/alerts/99999/acknowledge');
    assert.equal(res.status, 404);
  });
});
