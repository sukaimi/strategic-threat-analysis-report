'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { validate } = require('../middleware/validate');
const { normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

const validateFlight = validate({
  callsign:    { required: true, type: 'string', pattern: /^[A-Za-z0-9]{2,8}$/, patternMsg: 'callsign must be 2-8 alphanumeric characters' },
  lat:         { type: 'number', min: -90, max: 90 },
  lon:         { type: 'number', min: -180, max: 180 },
  altitude_ft: { type: 'number', min: 0 },
  speed_kt:    { type: 'number', min: 0 },
  heading:     { type: 'number', min: 0, max: 360 },
  squawk:      { type: 'string', pattern: /^\d{4}$/, patternMsg: 'squawk must be a 4-digit string' },
});

// GET /api/flights — latest position per callsign (60s window, fallback to most recent)
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();

    // Latest position per callsign within the time window
    let rows = db.prepare(
      `SELECT f.* FROM flights f
       INNER JOIN (
         SELECT callsign, MAX(recorded_at) AS max_ts
         FROM flights
         WHERE recorded_at >= datetime('now', '-60 seconds')
         GROUP BY callsign
       ) latest ON f.callsign = latest.callsign AND f.recorded_at = latest.max_ts
       ORDER BY f.recorded_at DESC`
    ).all();

    // Fallback: if no recent data, return latest position per callsign (72h horizon)
    if (rows.length === 0) {
      rows = db.prepare(
        `SELECT f.* FROM flights f
         INNER JOIN (
           SELECT callsign, MAX(recorded_at) AS max_ts
           FROM flights
           WHERE callsign IS NOT NULL
             AND recorded_at >= datetime('now', '-72 hours')
           GROUP BY callsign
         ) latest ON f.callsign = latest.callsign AND f.recorded_at = latest.max_ts
         ORDER BY f.recorded_at DESC
         LIMIT 200`
      ).all();
    }

    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/flights/trails — recent positions for all flights, grouped by callsign
router.get('/trails', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const minutes = Math.max(1, Math.min(30, parseInt(req.query.minutes, 10) || 5));

    const rows = db.prepare(
      `SELECT callsign, lat, lon, heading, speed_kt, altitude_ft, recorded_at
       FROM flights
       WHERE recorded_at >= datetime('now', '-' || ? || ' minutes')
         AND lat IS NOT NULL AND lon IS NOT NULL
         AND callsign IS NOT NULL AND callsign != ''
       ORDER BY callsign, recorded_at ASC`
    ).all(minutes);

    const normalized = normalizeTimestampsArray(rows);
    const grouped = {};
    for (const row of normalized) {
      if (!grouped[row.callsign]) grouped[row.callsign] = [];
      grouped[row.callsign].push({
        lat: row.lat, lon: row.lon, heading: row.heading,
        speed_kt: row.speed_kt, altitude_ft: row.altitude_ft,
        recorded_at: row.recorded_at,
      });
    }

    const result = {};
    for (const [cs, positions] of Object.entries(grouped)) {
      if (positions.length >= 2) result[cs] = positions;
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/flights/:callsign/track — historical positions for a given callsign
router.get('/:callsign/track', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { callsign } = req.params;
    const MAX_HOURS = 72;
    const now = new Date();

    let from = req.query.from ? new Date(req.query.from) : new Date(now.getTime() - 60 * 60 * 1000);
    let to = req.query.to ? new Date(req.query.to) : now;

    const earliest = new Date(now.getTime() - MAX_HOURS * 60 * 60 * 1000);
    if (from < earliest) from = earliest;
    if (to > now) to = now;
    if (from >= to) return res.json([]);

    const rows = db.prepare(
      `SELECT callsign, lat, lon, altitude_ft, speed_kt, heading, recorded_at
       FROM flights
       WHERE callsign = ? AND recorded_at >= ? AND recorded_at <= ?
       ORDER BY recorded_at ASC`
    ).all(callsign, from.toISOString(), to.toISOString());

    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// POST /api/flights — insert a flight record
router.post('/', validateFlight, (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { callsign, squawk, lat, lon, altitude_ft, speed_kt, heading } = req.body;
    const info = db.prepare(
      'INSERT INTO flights (callsign, squawk, lat, lon, altitude_ft, speed_kt, heading) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(callsign ?? null, squawk ?? null, lat ?? null, lon ?? null, altitude_ft ?? null, speed_kt ?? null, heading ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
