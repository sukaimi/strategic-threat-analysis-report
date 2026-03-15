'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { normalizeTimestamps, normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

// GET /api/analyses — latest analysis
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const row = db.prepare(
      'SELECT * FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1'
    ).get();
    res.json(normalizeTimestamps(row) || null);
  } catch (err) {
    next(err);
  }
});

// GET /api/analyses/count — total analysis count (diagnostic)
router.get('/count', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const row = db.prepare('SELECT COUNT(*) AS count FROM ai_analyses').get();
    res.json({ count: row?.count || 0 });
  } catch (err) {
    next(err);
  }
});

// GET /api/analyses/history — last 24 hours of analyses
router.get('/history', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const rows = db.prepare(
      "SELECT * FROM ai_analyses WHERE recorded_at >= datetime('now', '-24 hours') ORDER BY recorded_at DESC"
    ).all();
    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// POST /api/analyses — insert an analysis
router.post('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { composite_score, threat_json, tactical_brief } = req.body;
    const info = db.prepare(
      'INSERT INTO ai_analyses (composite_score, threat_json, tactical_brief) VALUES (?, ?, ?)'
    ).run(composite_score ?? null, threat_json ?? null, tactical_brief ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
