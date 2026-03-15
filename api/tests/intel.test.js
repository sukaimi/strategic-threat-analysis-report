'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { getDb, close } = require('../src/db');

// Clear API key so auth middleware skips in test mode
process.env.API_KEY = '';
delete require.cache[require.resolve('../src/config')];

// Initialise in-memory SQLite before loading app
before(() => {
  close();
  getDb(':memory:');

  // Seed test intel articles
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO intel_articles (title, summary, source, link, guid, relevance_score, published_at, dedup_hash) VALUES (?, ?, ?, ?, ?, ?, ?, hex(randomblob(16)))"
  );

  insert.run(
    'Piracy alert in Singapore Strait',
    'Armed robbery reported in Philip Channel near MMSI 353456789',
    'IMB',
    'https://example.com/piracy-alert',
    'guid-1',
    85,
    new Date().toISOString()
  );

  insert.run(
    'New container terminal opens in Rotterdam',
    'The Port of Rotterdam inaugurated a new automated container terminal.',
    'PortNews',
    'https://example.com/rotterdam',
    'guid-2',
    15,
    '2024-01-15T12:00:00Z'
  );

  insert.run(
    'Suspicious vessel near Batam',
    'Coast guard investigating vessel with AIS transponder off near Batam waters.',
    'IMB',
    'https://example.com/batam-vessel',
    'guid-3',
    62,
    new Date().toISOString()
  );
});

const app = require('../src/app');

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// GET /api/intel
// ---------------------------------------------------------------------------
describe('Intel API', () => {
  it('GET /api/intel returns 200 with array', async () => {
    const res = await request(app).get('/api/intel');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('GET /api/intel returns inserted articles (above default minScore)', async () => {
    const res = await request(app).get('/api/intel?minScore=0');
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 2, `Expected at least 2 high-score articles but got ${res.body.length}`);
    const titles = res.body.map((a) => a.title);
    assert.ok(titles.includes('Piracy alert in Singapore Strait'));
    assert.ok(titles.includes('Suspicious vessel near Batam'));
  });

  it('GET /api/intel?minScore=50 filters low-relevance articles', async () => {
    const res = await request(app).get('/api/intel?minScore=50');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    // Rotterdam article (score 15) should be filtered out
    for (const article of res.body) {
      assert.ok(
        article.relevance_score >= 50,
        `Article "${article.title}" has score ${article.relevance_score}, expected >= 50`
      );
    }
    const titles = res.body.map((a) => a.title);
    assert.ok(!titles.includes('New container terminal opens in Rotterdam'), 'Low-score article should be filtered');
  });

  it('GET /api/intel?limit=2 limits results', async () => {
    const res = await request(app).get('/api/intel?limit=2');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length <= 2, `Expected at most 2 articles but got ${res.body.length}`);
  });

  it('GET /api/intel/stats returns source counts', async () => {
    const res = await request(app).get('/api/intel/stats');
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 3, 'Should have at least 3 total articles');
    assert.ok(Array.isArray(res.body.by_source));
    const imb = res.body.by_source.find((s) => s.source === 'IMB');
    assert.ok(imb, 'Should have IMB source in stats');
    assert.equal(imb.article_count, 2);
  });
});
