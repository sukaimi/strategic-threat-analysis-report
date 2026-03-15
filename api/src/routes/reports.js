'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { generateSITREP } = require('../services/pdf');
const { normalizeTimestamps, normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

/**
 * Gather SITREP data from the database.
 */
function gatherSitrepData(db) {
  if (!db) db = getDb();

  // Latest SUCCESSFUL AI analysis (fall back to latest attempt if none succeeded)
  const analysis = db.prepare(
    "SELECT * FROM ai_analyses WHERE tactical_brief NOT LIKE 'Analysis unavailable:%' ORDER BY recorded_at DESC LIMIT 1"
  ).get()
    || db.prepare(
      'SELECT * FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1'
    ).get()
    || null;

  // Active (unacknowledged) alerts
  const alerts = db.prepare(
    'SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT 100'
  ).all();

  // Vessel count (deduplicated by MMSI)
  const vesselRow = db.prepare(
    'SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels'
  ).get();
  const vesselCount = vesselRow?.cnt ?? 0;

  // Flight count (deduplicated by callsign)
  const flightRow = db.prepare(
    'SELECT COUNT(DISTINCT callsign) AS cnt FROM flights'
  ).get();
  const flightCount = flightRow?.cnt ?? 0;

  // Latest weather
  const weather = db.prepare(
    'SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1'
  ).get() || null;

  // Tanker count (DJINN enrichment)
  let tankerCount = 0;
  try {
    const tankerRow = db.prepare(
      "SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels WHERE vessel_type LIKE '%Tanker%' AND recorded_at >= datetime('now', '-5 minutes')"
    ).get();
    tankerCount = tankerRow?.cnt ?? 0;
  } catch (_) {}

  // Flagged/sanctioned vessel count
  let flaggedCount = 0;
  try {
    const flaggedRow = db.prepare(
      "SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels WHERE flagged = 1 AND recorded_at >= datetime('now', '-5 minutes')"
    ).get();
    flaggedCount = flaggedRow?.cnt ?? 0;
  } catch (_) {}

  return { analysis: normalizeTimestamps(analysis), alerts: normalizeTimestampsArray(alerts), vesselCount, flightCount, tankerCount, flaggedCount, weather: normalizeTimestamps(weather) };
}

// GET /api/reports/sitrep
router.get('/sitrep', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const data = gatherSitrepData(db);

    // JSON format requested
    if (req.query.format === 'json') {
      return res.json(data);
    }

    // Generate PDF
    const dtg = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const filename = `SITREP_MERLION_${dtg}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const pdfStream = generateSITREP(data);
    pdfStream.pipe(res);

    pdfStream.on('error', (err) => {
      console.error('[reports] PDF generation error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'PDF generation failed' });
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
