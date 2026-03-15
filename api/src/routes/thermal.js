'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

// GET /api/thermal — recent thermal detections (NASA FIRMS)
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const hours = parseInt(req.query.hours, 10) || 24;
    const minConfidence = req.query.minConfidence || null; // 'nominal', 'high', 'low'

    // Check if table exists (may not exist in merlion theater)
    let rows;
    try {
      let sql = `SELECT * FROM thermal_detections
                 WHERE detected_at >= datetime('now', '-' || ? || ' hours')`;
      const params = [hours];

      if (minConfidence) {
        sql += ' AND confidence = ?';
        params.push(minConfidence);
      }

      sql += ' ORDER BY detected_at DESC LIMIT ?';
      params.push(limit);

      rows = db.prepare(sql).all(...params);
    } catch (err) {
      // Table doesn't exist in this theater — return empty
      if (err.message.includes('no such table')) {
        return res.json([]);
      }
      throw err;
    }

    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/thermal/stats — summary statistics
router.get('/stats', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();

    let stats;
    try {
      stats = db.prepare(
        `SELECT
           COUNT(*) AS total,
           COUNT(CASE WHEN detected_at >= datetime('now', '-24 hours') THEN 1 END) AS last_24h,
           ROUND(AVG(brightness), 1) AS avg_brightness,
           ROUND(AVG(frp), 1) AS avg_frp,
           MAX(detected_at) AS latest_at
         FROM thermal_detections`
      ).get();
    } catch (err) {
      if (err.message.includes('no such table')) {
        return res.json({ total: 0, last_24h: 0, avg_brightness: null, avg_frp: null, latest_at: null });
      }
      throw err;
    }

    res.json(stats);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
