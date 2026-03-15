'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const config = require('../config');
const { normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

// GET /api/intel — recent intel articles
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const minScore = parseInt(req.query.minScore, 10) || config.OSINT_MIN_RELEVANCE;
    const hours = parseInt(req.query.hours, 10) || 72;

    const rows = db.prepare(
      `SELECT * FROM intel_articles
       WHERE relevance_score >= ?
         AND created_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY relevance_score DESC, created_at DESC
       LIMIT ?`
    ).all(minScore, hours, limit);

    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/intel/stats — counts by source and avg relevance
router.get('/stats', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();

    const rows = db.prepare(
      `SELECT source,
              COUNT(*) AS article_count,
              ROUND(AVG(relevance_score), 1) AS avg_relevance,
              MAX(created_at) AS latest_at
       FROM intel_articles
       GROUP BY source
       ORDER BY article_count DESC`
    ).all();

    const total = db.prepare('SELECT COUNT(*) AS count FROM intel_articles').get();

    res.json({ total: total.count, by_source: normalizeTimestampsArray(rows) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
