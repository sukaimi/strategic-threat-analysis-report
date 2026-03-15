'use strict';

/**
 * NASA FIRMS (Fire Information for Resource Management System) collector.
 *
 * Fetches thermal anomaly / fire detections from VIIRS S-NPP near the
 * Strait of Hormuz. Detects oil rig flares, refinery activity, potential
 * military strikes, and vessel fires.
 *
 * Requires free FIRMS_API_KEY (register at https://firms.modaps.eosdis.nasa.gov/api/).
 * Polls every 6 hours (data updates ~4x daily).
 * Optional: only runs if FIRMS_API_KEY is set.
 */

const crypto = require('node:crypto');
const config = require('../config');
const { getDb } = require('../db');

const USER_AGENT = 'STAR-MERLION/2.0 (maritime-intelligence-system)';

let _timer = null;
let _stats = {
  lastFetchAt: null,
  fetchCount: 0,
  errorCount: 0,
  detectionCount: 0,
  lastError: null,
};

// Bounding box: west,south,east,north for Persian Gulf / Hormuz region
// Format for FIRMS API: south,west,north,east
const FIRMS_BBOX = '24,51,28,58';
const FIRMS_BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/**
 * Parse FIRMS CSV response into detection objects.
 * CSV columns: latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,
 *              confidence,version,bright_ti5,frp,daynight
 * @param {string} csv
 * @returns {Array<{lat: number, lon: number, brightness: number, confidence: string, frp: number, satellite: string, detected_at: string}>}
 */
function parseFirmsCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const latIdx = header.indexOf('latitude');
  const lonIdx = header.indexOf('longitude');
  const brightIdx = header.indexOf('bright_ti4');
  const confIdx = header.indexOf('confidence');
  const frpIdx = header.indexOf('frp');
  const satIdx = header.indexOf('satellite');
  const dateIdx = header.indexOf('acq_date');
  const timeIdx = header.indexOf('acq_time');

  if (latIdx === -1 || lonIdx === -1) return [];

  const detections = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < header.length) continue;

    const lat = parseFloat(cols[latIdx]);
    const lon = parseFloat(cols[lonIdx]);
    if (isNaN(lat) || isNaN(lon)) continue;

    const brightness = parseFloat(cols[brightIdx]) || 0;
    const confidence = cols[confIdx]?.trim() || 'unknown';
    const frp = parseFloat(cols[frpIdx]) || 0;
    const satellite = cols[satIdx]?.trim() || 'VIIRS';

    // Build ISO datetime from acq_date (YYYY-MM-DD) + acq_time (HHMM)
    let detected_at = null;
    const dateStr = cols[dateIdx]?.trim();
    const timeStr = cols[timeIdx]?.trim();
    if (dateStr) {
      const hh = timeStr ? timeStr.slice(0, 2) : '00';
      const mm = timeStr ? timeStr.slice(2, 4) : '00';
      detected_at = `${dateStr}T${hh}:${mm}:00Z`;
    }

    detections.push({ lat, lon, brightness, confidence, frp, satellite, detected_at });
  }

  return detections;
}

/**
 * Compute dedup hash for a thermal detection.
 */
function dedupHash(lat, lon, detected_at) {
  return crypto.createHash('sha256')
    .update(`firms:${lat.toFixed(4)}:${lon.toFixed(4)}:${detected_at}`)
    .digest('hex');
}

/**
 * Fetch FIRMS data and store in thermal_detections table.
 */
async function _refresh() {
  if (!config.FIRMS_API_KEY) return;

  // FIRMS API: /api/area/csv/{MAP_KEY}/{source}/{bbox}/{days}
  const url = `${FIRMS_BASE_URL}/${config.FIRMS_API_KEY}/VIIRS_SNPP_NRT/${FIRMS_BBOX}/1`;
  console.log('[firms] Fetching thermal detections for Hormuz region');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from FIRMS API`);
    }

    const csv = await res.text();
    const detections = parseFirmsCsv(csv);

    if (detections.length === 0) {
      _stats.lastFetchAt = new Date().toISOString();
      _stats.fetchCount++;
      return;
    }

    // Get DJINN DB
    let db;
    try {
      db = getDb('djinn');
    } catch (err) {
      console.error('[firms] Cannot open DJINN DB: %s', err.message);
      return;
    }

    // Ensure thermal_detections table exists (also added to db.js _bootstrap)
    db.exec(`
      CREATE TABLE IF NOT EXISTS thermal_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lat REAL,
        lon REAL,
        brightness REAL,
        confidence TEXT,
        frp REAL,
        satellite TEXT,
        detected_at TEXT,
        dedup_hash TEXT UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_thermal_detected ON thermal_detections(detected_at);
      CREATE INDEX IF NOT EXISTS idx_thermal_dedup ON thermal_detections(dedup_hash);
    `);

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO thermal_detections
       (lat, lon, brightness, confidence, frp, satellite, detected_at, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;

    for (const d of detections) {
      const hash = dedupHash(d.lat, d.lon, d.detected_at || '');
      const info = insertStmt.run(
        d.lat, d.lon, d.brightness, d.confidence,
        d.frp, d.satellite, d.detected_at, hash
      );
      if (info.changes > 0) inserted++;
    }

    _stats.lastFetchAt = new Date().toISOString();
    _stats.fetchCount++;
    _stats.detectionCount += inserted;

    if (inserted > 0) {
      console.log('[firms] Ingested %d new thermal detections from %d total', inserted, detections.length);
    }
  } catch (err) {
    _stats.errorCount++;
    _stats.lastError = err.message;
    console.error('[firms] Fetch error: %s', err.message);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function start() {
  if (_timer) return;
  if (!config.FIRMS_API_KEY) {
    console.log('[firms] No FIRMS_API_KEY configured — collector disabled');
    return;
  }

  const intervalMs = config.FIRMS_REFRESH_INTERVAL_MS || DEFAULT_INTERVAL_MS;
  console.log('[firms] collector started — refreshing every %d hours', intervalMs / 3600000);
  _refresh();
  _timer = setInterval(_refresh, intervalMs);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[firms] collector stopped');
  }
}

function getStats() {
  return { ..._stats };
}

module.exports = { start, stop, getStats, parseFirmsCsv, dedupHash };
