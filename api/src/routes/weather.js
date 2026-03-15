'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { normalizeTimestamps } = require('../utils/normalizeTimestamps');

const router = Router();

// GET /api/weather — latest weather record
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const row = db.prepare(
      'SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1'
    ).get();
    res.json(normalizeTimestamps(row) || null);
  } catch (err) {
    next(err);
  }
});

// POST /api/weather — insert a weather record
router.post('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { cb_cells, wind_speed_kt, wind_dir, visibility_km, sea_state } = req.body;
    const info = db.prepare(
      'INSERT INTO weather (cb_cells, wind_speed_kt, wind_dir, visibility_km, sea_state) VALUES (?, ?, ?, ?, ?)'
    ).run(cb_cells ?? null, wind_speed_kt ?? null, wind_dir ?? null, visibility_km ?? null, sea_state ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
