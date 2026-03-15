'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { normalizeTimestamps } = require('../utils/normalizeTimestamps');

const router = Router();

// GET /api/port — latest port status
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const row = db.prepare(
      'SELECT * FROM port_status ORDER BY recorded_at DESC LIMIT 1'
    ).get();
    res.json(normalizeTimestamps(row) || null);
  } catch (err) {
    next(err);
  }
});

// POST /api/port — insert a port status record
router.post('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { vessels_queued, berth_utilisation, channel_flow_pct } = req.body;
    const info = db.prepare(
      'INSERT INTO port_status (vessels_queued, berth_utilisation, channel_flow_pct) VALUES (?, ?, ?)'
    ).run(vessels_queued ?? null, berth_utilisation ?? null, channel_flow_pct ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
