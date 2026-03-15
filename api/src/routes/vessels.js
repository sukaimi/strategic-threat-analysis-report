'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { validate } = require('../middleware/validate');
const { fetchVesselDetails } = require('../collectors/mpa');
const { normalizeTimestamps, normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

const validateVessel = validate({
  mmsi:      { required: true, type: 'string', pattern: /^\d{9}$/, patternMsg: 'mmsi must be a 9-digit numeric string' },
  lat:       { type: 'number', min: -90, max: 90 },
  lon:       { type: 'number', min: -180, max: 180 },
  speed_kt:  { type: 'number', min: 0 },
  heading:   { type: 'number', min: 0, max: 360 },
});

// GET /api/vessels — latest position per MMSI (5-min window, fallback to most recent)
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();

    // Latest position per MMSI within the time window
    let rows = db.prepare(
      `SELECT v.* FROM vessels v
       INNER JOIN (
         SELECT mmsi, MAX(recorded_at) AS max_ts
         FROM vessels
         WHERE recorded_at >= datetime('now', '-5 minutes')
         GROUP BY mmsi
       ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
       ORDER BY v.recorded_at DESC`
    ).all();

    // Fallback: if no recent data, return latest position per MMSI (72h horizon)
    if (rows.length === 0) {
      rows = db.prepare(
        `SELECT v.* FROM vessels v
         INNER JOIN (
           SELECT mmsi, MAX(recorded_at) AS max_ts
           FROM vessels
           WHERE recorded_at >= datetime('now', '-72 hours')
           GROUP BY mmsi
         ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
         ORDER BY v.recorded_at DESC
         LIMIT 500`
      ).all();
    }

    // Enrich with ETA to Singapore pilotage boarding ground
    try {
      const eta = require('../services/eta');
      for (const v of rows) {
        v.eta_minutes = eta.calculateETAtoSingapore(v);
      }
    } catch (_) {}

    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/vessels/:mmsi/details — extended vessel particulars from MPA
router.get('/:mmsi/details', async (req, res, next) => {
  try {
    const { mmsi } = req.params;
    if (!mmsi || !/^\d{9}$/.test(mmsi)) {
      return res.status(400).json({ error: 'Invalid MMSI — must be 9 digits' });
    }
    const details = await fetchVesselDetails(mmsi);
    if (!details) {
      return res.status(404).json({ error: 'No vessel details found for this MMSI' });
    }
    res.json(details);
  } catch (err) {
    if (err.message.includes('MPA_API_KEY not set')) {
      return res.status(503).json({ error: 'MPA API key not configured' });
    }
    next(err);
  }
});

// GET /api/vessels/:mmsi/track — historical positions for a given MMSI
router.get('/:mmsi/track', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { mmsi } = req.params;
    const MAX_HOURS = 72;
    const now = new Date();

    let from = req.query.from ? new Date(req.query.from) : new Date(now.getTime() - 60 * 60 * 1000);
    let to = req.query.to ? new Date(req.query.to) : now;

    const earliest = new Date(now.getTime() - MAX_HOURS * 60 * 60 * 1000);
    if (from < earliest) from = earliest;
    if (to > now) to = now;
    if (from >= to) return res.json([]);

    const rows = db.prepare(
      `SELECT mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type, recorded_at
       FROM vessels
       WHERE mmsi = ? AND recorded_at >= ? AND recorded_at <= ?
       ORDER BY recorded_at ASC`
    ).all(mmsi, from.toISOString(), to.toISOString());

    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/vessels/density — heatmap density grid (DJINN)
router.get('/density', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const rows = db.prepare(
      `SELECT ROUND(lat, 2) AS lat_bin, ROUND(lon, 2) AS lon_bin, COUNT(*) AS cnt
       FROM vessels
       WHERE recorded_at >= datetime('now', '-60 minutes')
         AND lat IS NOT NULL AND lon IS NOT NULL
       GROUP BY lat_bin, lon_bin`
    ).all();
    const tuples = rows.map(r => [r.lat_bin, r.lon_bin, r.cnt]);
    res.json(tuples);
  } catch (err) {
    next(err);
  }
});

// GET /api/vessels/tanker-flow — tanker IN/OUT through Hormuz (DJINN)
router.get('/tanker-flow', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    // Hormuz TSS bounds (approximate)
    const latMin = 26.0, latMax = 26.65, lonMin = 56.0, lonMax = 56.6;
    const rows = db.prepare(
      `SELECT v.mmsi, v.heading, v.vessel_type, v.vessel_name
       FROM vessels v
       INNER JOIN (
         SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
         WHERE recorded_at >= datetime('now', '-60 minutes')
         GROUP BY mmsi
       ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
       WHERE v.lat BETWEEN ? AND ?
         AND v.lon BETWEEN ? AND ?
         AND v.heading IS NOT NULL
         AND (LOWER(v.vessel_type) LIKE '%tanker%' OR LOWER(v.vessel_type) LIKE '%oil%'
              OR LOWER(v.vessel_type) LIKE '%chemical%' OR LOWER(v.vessel_type) LIKE '%lng%'
              OR LOWER(v.vessel_type) LIKE '%lpg%')`
    ).all(latMin, latMax, lonMin, lonMax);

    let inbound = 0;
    let outbound = 0;
    for (const r of rows) {
      const h = r.heading;
      // Inbound (NW-bound into Gulf): heading 270-360 or 0-90
      if ((h >= 270 && h <= 360) || (h >= 0 && h <= 90)) {
        inbound++;
      } else {
        // Outbound (SE-bound, 90-270)
        outbound++;
      }
    }
    res.json({ inbound, outbound, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/vessels/tss-flow — average heading and vessel count per TSS lane (DJINN)
router.get('/tss-flow', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const theaters = require('../theaters');
    const djinn = theaters.djinn;
    if (!djinn || !djinn.tssLanes) {
      return res.json({ inbound: null, outbound: null });
    }

    const result = {};
    for (const [laneKey, lane] of Object.entries(djinn.tssLanes)) {
      if (laneKey === 'separation') continue;
      const row = db.prepare(
        `SELECT AVG(v.heading) AS avg_heading, COUNT(DISTINCT v.mmsi) AS vessel_count
         FROM vessels v
         INNER JOIN (
           SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
           WHERE recorded_at >= datetime('now', '-30 minutes')
           GROUP BY mmsi
         ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
         WHERE v.lat BETWEEN ? AND ?
           AND v.lon BETWEEN ? AND ?
           AND v.heading IS NOT NULL`
      ).get(lane.latMin, lane.latMax, lane.lonMin, lane.lonMax);

      result[laneKey] = {
        avg_heading: row.avg_heading != null ? Math.round(row.avg_heading) : null,
        vessel_count: row.vessel_count || 0,
        lane: {
          latMin: lane.latMin,
          latMax: lane.latMax,
          lonMin: lane.lonMin,
          lonMax: lane.lonMax,
          label: lane.label,
        },
      };
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/vessels — insert a vessel record
router.post('/', validateVessel, (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type, flagged } = req.body;
    const info = db.prepare(
      'INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type, flagged) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(mmsi, lat ?? null, lon ?? null, speed_kt ?? null, heading ?? null, vessel_name ?? null, vessel_type ?? null, flagged ?? 0);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
