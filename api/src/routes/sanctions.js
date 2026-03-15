'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const sanctions = require('../services/sanctions');
const { normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

// GET /api/sanctions/status — list stats, entity count, last refresh
router.get('/status', (_req, res, next) => {
  try {
    const stats = sanctions.getStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/sanctions/matches — recent sanctions-related alerts
router.get('/matches', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const rows = db.prepare(
      `SELECT * FROM alerts
       WHERE title LIKE '%Sanctions%'
       ORDER BY created_at DESC
       LIMIT 100`
    ).all();
    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// POST /api/sanctions/screen — manual screening endpoint
router.post('/screen', (req, res, next) => {
  try {
    const { mmsi, imo, vessel_name, flag_state } = req.body;

    if (!mmsi && !imo && !vessel_name) {
      return res.status(400).json({
        error: 'At least one of mmsi, imo, or vessel_name is required',
      });
    }

    const result = sanctions.screenVessel({ mmsi, imo, vessel_name, flag_state });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
