'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { getDb, close } = require('../src/db');

// Initialise in-memory SQLite before loading app (so routes pick it up)
before(() => {
  close();
  getDb(':memory:');
});

const app = require('../src/app');

after(() => {
  close();
});

describe('GET /api/health', () => {
  it('returns 200 with status "ok"', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(typeof res.body.uptime === 'number');
    assert.ok(typeof res.body.timestamp === 'string');
  });

  it('includes sqlite and vault service checks', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.ok('services' in res.body);
    assert.ok(typeof res.body.services.sqlite === 'boolean');
    assert.ok(typeof res.body.services.vault === 'boolean');
    // SQLite should be ok since we initialised in-memory
    assert.equal(res.body.services.sqlite, true);
  });
});
