'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { normalizeTimestamps, normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

// ---------------------------------------------------------------------------
// Helper — query latest positions (same logic as server.js / vessels route)
// ---------------------------------------------------------------------------

function queryLatestVessels(db) {
  let rows = db.prepare(
    `SELECT v.* FROM vessels v
     INNER JOIN (
       SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
       WHERE recorded_at >= datetime('now', '-5 minutes') GROUP BY mmsi
     ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
     ORDER BY v.recorded_at DESC`
  ).all();
  if (rows.length === 0) {
    rows = db.prepare(
      `SELECT v.* FROM vessels v
       INNER JOIN (
         SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels GROUP BY mmsi
       ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
       ORDER BY v.recorded_at DESC LIMIT 500`
    ).all();
  }
  return rows;
}

function queryLatestFlights(db) {
  let rows = db.prepare(
    `SELECT f.* FROM flights f
     INNER JOIN (
       SELECT callsign, MAX(recorded_at) AS max_ts FROM flights
       WHERE recorded_at >= datetime('now', '-60 seconds') GROUP BY callsign
     ) latest ON f.callsign = latest.callsign AND f.recorded_at = latest.max_ts
     ORDER BY f.recorded_at DESC`
  ).all();
  if (rows.length === 0) {
    rows = db.prepare(
      `SELECT f.* FROM flights f
       INNER JOIN (
         SELECT callsign, MAX(recorded_at) AS max_ts FROM flights GROUP BY callsign
       ) latest ON f.callsign = latest.callsign AND f.recorded_at = latest.max_ts
       ORDER BY f.recorded_at DESC LIMIT 200`
    ).all();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// GET /api/export/tracks — vessel + flight positions as GeoJSON
// ---------------------------------------------------------------------------

router.get('/tracks', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const vessels = normalizeTimestampsArray(queryLatestVessels(db));
    const flights = normalizeTimestampsArray(queryLatestFlights(db));

    const features = [];

    for (const v of vessels) {
      if (v.lat == null || v.lon == null) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: {
          entityType: 'vessel',
          mmsi: v.mmsi,
          name: v.vessel_name,
          vesselType: v.vessel_type,
          speed_kt: v.speed_kt,
          heading: v.heading,
          recordedAt: v.recorded_at,
        },
      });
    }

    for (const f of flights) {
      if (f.lat == null || f.lon == null) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat, f.altitude_ft || 0] },
        properties: {
          entityType: 'flight',
          callsign: f.callsign,
          squawk: f.squawk,
          altitude_ft: f.altitude_ft,
          speed_kt: f.speed_kt,
          heading: f.heading,
          recordedAt: f.recorded_at,
        },
      });
    }

    res.json({
      type: 'FeatureCollection',
      generated: new Date().toISOString(),
      features,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/export/alerts — alerts as JSON, optional ?severity= filter
// ---------------------------------------------------------------------------

router.get('/alerts', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { severity } = req.query;

    let rows;
    if (severity) {
      const allowed = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      const upper = severity.toUpperCase();
      if (!allowed.includes(upper)) {
        return res.status(400).json({ error: `Invalid severity. Must be one of: ${allowed.join(', ')}` });
      }
      rows = db.prepare(
        "SELECT * FROM alerts WHERE severity = ? AND created_at >= datetime('now', '-72 hours') ORDER BY created_at DESC"
      ).all(upper);
    } else {
      rows = db.prepare(
        "SELECT * FROM alerts WHERE created_at >= datetime('now', '-72 hours') ORDER BY created_at DESC"
      ).all();
    }

    res.json({
      generated: new Date().toISOString(),
      count: rows.length,
      alerts: normalizeTimestampsArray(rows),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/export/situation — full situation snapshot
// ---------------------------------------------------------------------------

router.get('/situation', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();

    const vessels = normalizeTimestampsArray(queryLatestVessels(db));
    const flights = normalizeTimestampsArray(queryLatestFlights(db));
    const weather = normalizeTimestamps(db.prepare('SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1').get()) || null;
    const analysisRow = normalizeTimestamps(db.prepare('SELECT * FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1').get()) || null;
    const alerts = normalizeTimestampsArray(db.prepare(
      "SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC"
    ).all());

    let analysis = null;
    if (analysisRow) {
      try {
        analysis = JSON.parse(analysisRow.threat_json);
      } catch (_) {
        analysis = { raw: analysisRow.threat_json };
      }
    }

    res.json({
      generated: new Date().toISOString(),
      vessels: { count: vessels.length, data: vessels },
      flights: { count: flights.length, data: flights },
      weather,
      analysis,
      alerts: { count: alerts.length, data: alerts },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
