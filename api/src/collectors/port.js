'use strict';

const { getDb } = require('../db');

const POLL_INTERVAL_MS = 300000; // 5 minutes
const VESSEL_ARRIVAL_URL = 'https://api.data.gov.sg/v1/transport/maritime/vessel-arrival-declaration';

// Singapore anchorage bounding box
const ANCHORAGE_LAT_MIN = 1.1;
const ANCHORAGE_LAT_MAX = 1.3;
const ANCHORAGE_LON_MIN = 103.6;
const ANCHORAGE_LON_MAX = 104.0;

// Estimated capacities
const BERTH_CAPACITY = 60;
const CHANNEL_CAPACITY_ESTIMATE = 40;

let _timer = null;
let _stats = {
  lastFetchAt: null,
  lastSuccessAt: null,
  fetchCount: 0,
  errorCount: 0,
  running: false,
};

/**
 * Derive port metrics from vessel positions already stored in the SQLite DB.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ vessels_queued: number, berth_utilisation: number, channel_flow_pct: number }}
 */
function derivePortMetrics(db) {
  // Vessels queued: distinct MMSIs with speed < 2kt inside Singapore anchorage area
  // Use the most recent record per MMSI (within last 30 minutes)
  const queued = db.prepare(`
    SELECT COUNT(DISTINCT mmsi) AS cnt
    FROM vessels
    WHERE speed_kt < 2
      AND lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
      AND recorded_at >= datetime('now', '-30 minutes')
  `).get(ANCHORAGE_LAT_MIN, ANCHORAGE_LAT_MAX, ANCHORAGE_LON_MIN, ANCHORAGE_LON_MAX);

  const vessels_queued = queued ? queued.cnt : 0;

  // Vessels at berth: speed essentially 0 (< 0.5kt) in anchorage area
  const berthed = db.prepare(`
    SELECT COUNT(DISTINCT mmsi) AS cnt
    FROM vessels
    WHERE speed_kt < 0.5
      AND lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
      AND recorded_at >= datetime('now', '-30 minutes')
  `).get(ANCHORAGE_LAT_MIN, ANCHORAGE_LAT_MAX, ANCHORAGE_LON_MIN, ANCHORAGE_LON_MAX);

  const berthedCount = berthed ? berthed.cnt : 0;
  const berth_utilisation = Math.min(1, Math.max(0, berthedCount / BERTH_CAPACITY));

  // Channel flow: vessels transiting at speed > 5kt in the area
  const transiting = db.prepare(`
    SELECT COUNT(DISTINCT mmsi) AS cnt
    FROM vessels
    WHERE speed_kt > 5
      AND lat BETWEEN ? AND ?
      AND lon BETWEEN ? AND ?
      AND recorded_at >= datetime('now', '-30 minutes')
  `).get(ANCHORAGE_LAT_MIN, ANCHORAGE_LAT_MAX, ANCHORAGE_LON_MIN, ANCHORAGE_LON_MAX);

  const transitCount = transiting ? transiting.cnt : 0;
  const channel_flow_pct = Math.min(100, Math.max(0, (transitCount / CHANNEL_CAPACITY_ESTIMATE) * 100));

  return { vessels_queued, berth_utilisation, channel_flow_pct };
}

/**
 * Fetch vessel arrival data from data.gov.sg and derive port metrics.
 * Falls back to DB-only derivation if the API call fails.
 * @returns {Promise<{ vessels_queued: number, berth_utilisation: number, channel_flow_pct: number }>}
 */
async function fetchPortStatus() {
  const db = getDb();
  let apiData = null;

  try {
    const res = await fetch(VESSEL_ARRIVAL_URL, {
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      apiData = await res.json();
    }
  } catch (_err) {
    // API unavailable — fall through to DB-derived metrics
  }

  // Derive metrics from local vessel DB
  const metrics = derivePortMetrics(db);

  // If API returned data, supplement the queued count with arrival declarations
  if (apiData && Array.isArray(apiData.result) && apiData.result.length > 0) {
    // Use the API vessel count as additional signal if it's higher
    const apiCount = apiData.result.length;
    if (apiCount > metrics.vessels_queued) {
      metrics.vessels_queued = apiCount;
    }
  }

  return metrics;
}

/**
 * Single poll cycle: fetch port status and write to DB.
 */
async function _poll() {
  _stats.fetchCount++;
  _stats.lastFetchAt = new Date().toISOString();

  try {
    const metrics = await fetchPortStatus();
    const db = getDb();

    db.prepare(
      'INSERT INTO port_status (vessels_queued, berth_utilisation, channel_flow_pct) VALUES (?, ?, ?)'
    ).run(metrics.vessels_queued, metrics.berth_utilisation, metrics.channel_flow_pct);

    _stats.lastSuccessAt = new Date().toISOString();
  } catch (err) {
    _stats.errorCount++;
    console.error('[port-collector] poll error:', err.message);
  }
}

/**
 * Start the port status collector.
 */
function start() {
  if (_timer) return;
  _stats.running = true;
  // Fire immediately, then repeat
  _poll();
  _timer = setInterval(_poll, POLL_INTERVAL_MS);
  console.log('[port-collector] started — polling every %ds', POLL_INTERVAL_MS / 1000);
}

/**
 * Stop the port status collector.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _stats.running = false;
  console.log('[port-collector] stopped');
}

/**
 * Return collector statistics.
 * @returns {object}
 */
function getStats() {
  return { ..._stats };
}

module.exports = { start, stop, getStats, fetchPortStatus, derivePortMetrics };
