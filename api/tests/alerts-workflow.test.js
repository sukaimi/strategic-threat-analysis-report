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
// C5: Alert workflow — status, category, assignment
// ---------------------------------------------------------------------------
describe('Alert workflow — status transitions', () => {
  let alertId;

  it('POST /api/alerts creates alert with category', async () => {
    const res = await request(app).post('/api/alerts').send({
      severity: 'HIGH',
      title: 'TSS violation',
      description: 'Vessel in wrong lane',
      entity_mmsi: '111222333',
      category: 'NAVIGATIONAL',
    });
    assert.equal(res.status, 201);
    alertId = res.body.id;
    assert.ok(alertId);
  });

  it('GET /api/alerts returns NEW alerts by default', async () => {
    const res = await request(app).get('/api/alerts');
    assert.equal(res.status, 200);
    const alert = res.body.find(a => Number(a.id) === Number(alertId));
    assert.ok(alert, 'New alert should be in default list');
    assert.equal(alert.status, 'NEW');
    assert.equal(alert.category, 'NAVIGATIONAL');
  });

  it('GET /api/alerts?status=NEW returns only NEW alerts', async () => {
    const res = await request(app).get('/api/alerts?status=NEW');
    assert.equal(res.status, 200);
    const alert = res.body.find(a => Number(a.id) === Number(alertId));
    assert.ok(alert);
  });

  it('GET /api/alerts?category=NAVIGATIONAL filters by category', async () => {
    const res = await request(app).get('/api/alerts?status=NEW&category=NAVIGATIONAL');
    assert.equal(res.status, 200);
    const alert = res.body.find(a => Number(a.id) === Number(alertId));
    assert.ok(alert);
  });

  it('PATCH /:id/status — transitions to ACKNOWLEDGED', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${alertId}/status`)
      .send({ status: 'ACKNOWLEDGED', assigned_to: 'analyst_1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ACKNOWLEDGED');
  });

  it('PATCH /:id/status — transitions to INVESTIGATING', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${alertId}/status`)
      .send({ status: 'INVESTIGATING' });
    assert.equal(res.status, 200);
  });

  it('PATCH /:id/status — transitions to RESOLVED with notes', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${alertId}/status`)
      .send({ status: 'RESOLVED', resolution_notes: 'False positive — vessel was in transit' });
    assert.equal(res.status, 200);

    // Verify via GET /all
    const allRes = await request(app).get('/api/alerts/all');
    const resolved = allRes.body.find(a => Number(a.id) === Number(alertId));
    assert.ok(resolved);
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.resolution_notes, 'False positive — vessel was in transit');
    assert.ok(resolved.resolved_at, 'Should have resolved_at timestamp');
  });

  it('PATCH /:id/status — returns 400 for invalid status', async () => {
    const res = await request(app)
      .patch(`/api/alerts/${alertId}/status`)
      .send({ status: 'DELETED' });
    assert.equal(res.status, 400);
  });

  it('PATCH /:id/status — returns 404 for non-existent alert', async () => {
    const res = await request(app)
      .patch('/api/alerts/99999/status')
      .send({ status: 'ACKNOWLEDGED' });
    assert.equal(res.status, 404);
  });

  it('backward compat — PATCH /:id/acknowledge still works', async () => {
    // Create a new alert
    const createRes = await request(app).post('/api/alerts').send({
      severity: 'LOW',
      title: 'Test ack backward compat',
    });
    const newId = createRes.body.id;

    const res = await request(app).patch(`/api/alerts/${newId}/acknowledge`);
    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, true);

    // Verify status was also set to ACKNOWLEDGED
    const allRes = await request(app).get('/api/alerts/all');
    const acked = allRes.body.find(a => Number(a.id) === Number(newId));
    assert.equal(acked.status, 'ACKNOWLEDGED');
    assert.equal(acked.acknowledged, 1);
  });
});

// ---------------------------------------------------------------------------
// C5: DB schema — new columns
// ---------------------------------------------------------------------------
describe('Alert DB schema', () => {
  it('alerts table has status, assigned_to, resolution_notes, resolved_at, category columns', () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('alerts')").all();
    const colNames = info.map(c => c.name);
    assert.ok(colNames.includes('status'), 'Should have status column');
    assert.ok(colNames.includes('assigned_to'), 'Should have assigned_to column');
    assert.ok(colNames.includes('resolution_notes'), 'Should have resolution_notes column');
    assert.ok(colNames.includes('resolved_at'), 'Should have resolved_at column');
    assert.ok(colNames.includes('category'), 'Should have category column');
  });

  it('vessels table has imo_number, destination, draught, length, breadth, call_sign', () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info('vessels')").all();
    const colNames = info.map(c => c.name);
    assert.ok(colNames.includes('imo_number'), 'Should have imo_number column');
    assert.ok(colNames.includes('destination'), 'Should have destination column');
    assert.ok(colNames.includes('draught'), 'Should have draught column');
    assert.ok(colNames.includes('length'), 'Should have length column');
    assert.ok(colNames.includes('breadth'), 'Should have breadth column');
    assert.ok(colNames.includes('call_sign'), 'Should have call_sign column');
  });
});
