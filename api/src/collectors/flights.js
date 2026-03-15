'use strict';

const { getDb } = require('../db');
const config = require('../config');
const theaters = require('../theaters');

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const ADSB_FI_BASE = config.ADSB_FI_BASE_URL || 'https://opendata.adsb.fi/api/v2';
const ADSB_FI_URL = `${ADSB_FI_BASE}/lat/1.35/lon/103.82/dist/150`;

/**
 * Determine which theater a lat/lon belongs to based on flightBBox configs.
 * @returns {string|null}
 */
function resolveFlightTheater(lat, lon) {
  if (lat == null || lon == null) return null;
  for (const [key, t] of Object.entries(theaters)) {
    const bbox = t.flightBBox;
    if (lat >= bbox.lamin && lat <= bbox.lamax && lon >= bbox.lomin && lon <= bbox.lomax) {
      return key;
    }
  }
  return null;
}

let _timer = null;
let _polling = false;
let _lastPollAt = null;
let _aircraftCount = 0;
let _pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

/* ── Emergency squawk detection ─────────────────────────────────────── */

const EMERGENCY_SQUAWKS = {
  '7500': 'Hijack',
  '7600': 'Radio Failure (COMMS Lost)',
  '7700': 'General Emergency',
};

const SQUAWK_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Map<string, number>  key = "callsign:squawk", value = timestamp (ms)
const _recentSquawkAlerts = new Map();

/**
 * Purge stale entries from the dedup map so it doesn't grow unbounded.
 */
function _pruneSquawkDedup() {
  const cutoff = Date.now() - SQUAWK_DEDUP_WINDOW_MS;
  for (const [key, ts] of _recentSquawkAlerts) {
    if (ts < cutoff) _recentSquawkAlerts.delete(key);
  }
}

/**
 * Scan parsed flight rows for emergency squawk codes and insert CRITICAL
 * alerts into the database.  Deduplicates by callsign+squawk within a
 * 30-minute sliding window so the same event doesn't flood the alerts table.
 * @param {Array} rows - Parsed flight row objects from parseFlightData()
 * @param {import('better-sqlite3').Database} [db] - optional DB handle
 */
function checkEmergencySquawks(rows, db) {
  _pruneSquawkDedup();

  if (!db) db = getDb();
  const insertAlert = db.prepare(
    'INSERT INTO alerts (severity, title, description, entity_callsign) VALUES (?, ?, ?, ?)'
  );

  for (const r of rows) {
    if (!r.squawk || !EMERGENCY_SQUAWKS[r.squawk]) continue;

    // Use hex/icao if available, fallback to position hash for anonymous aircraft
    const identity = r.callsign || r.hex || r.icao || `anon-${r.lat}-${r.lon}`;
    const dedupKey = `${identity}:${r.squawk}`;

    const lastAlerted = _recentSquawkAlerts.get(dedupKey);
    if (lastAlerted && Date.now() - lastAlerted < SQUAWK_DEDUP_WINDOW_MS) {
      continue; // already alerted recently
    }

    const label = EMERGENCY_SQUAWKS[r.squawk];
    const callsign = r.callsign || 'UNKNOWN';
    const title = `SQUAWK ${r.squawk} — ${label}`;
    const description = [
      `Aircraft ${callsign} is transmitting emergency squawk ${r.squawk} (${label}).`,
      r.lat != null && r.lon != null ? `Position: ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : null,
      r.altitude_ft != null ? `Altitude: ${r.altitude_ft} ft` : null,
      r.speed_kt != null ? `Speed: ${r.speed_kt} kt` : null,
    ]
      .filter(Boolean)
      .join(' | ');

    insertAlert.run('CRITICAL', title, description, callsign);
    _recentSquawkAlerts.set(dedupKey, Date.now());

    console.log(`[flights] CRITICAL ALERT: ${title} — ${callsign}`);
  }
}

/**
 * Parse the raw adsb.fi JSON response into an array of row objects
 * suitable for insertion into the flights table.
 * @param {object} data - Raw adsb.fi response
 * @returns {Array<{callsign:string|null, squawk:string|null, lat:number|null, lon:number|null, altitude_ft:number|null, speed_kt:number|null, heading:number|null}>}
 */
function parseFlightData(data) {
  const acArray = data?.ac || data?.aircraft;
  if (!Array.isArray(acArray)) {
    return [];
  }

  return acArray.map((ac) => ({
    callsign: typeof ac.flight === 'string' ? ac.flight.trim() || null : null,
    hex: typeof ac.hex === 'string' ? ac.hex.trim() || null : null,
    icao: typeof ac.icao === 'string' ? ac.icao.trim() || null : null,
    squawk: ac.squawk != null ? String(ac.squawk) : null,
    lat: typeof ac.lat === 'number' ? ac.lat : null,
    lon: typeof ac.lon === 'number' ? ac.lon : null,
    altitude_ft: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
    speed_kt: typeof ac.gs === 'number' ? ac.gs : null,
    heading: typeof ac.track === 'number' ? ac.track : null,
  }));
}

/**
 * Insert an array of parsed flight rows into the database using a batch transaction.
 * @param {Array} rows
 * @param {import('better-sqlite3').Database} [db] - optional DB handle
 */
function insertFlights(rows, db) {
  if (rows.length === 0) return;

  // Deduplicate: keep latest per callsign in batch
  const dedupMap = new Map();
  for (const r of rows) {
    if (r.callsign) dedupMap.set(r.callsign, r);
  }
  const dedupRows = Array.from(dedupMap.values());

  if (!db) db = getDb();
  const stmt = db.prepare(
    'INSERT INTO flights (callsign, squawk, lat, lon, altitude_ft, speed_kt, heading) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((entries) => {
    for (const r of entries) {
      stmt.run(r.callsign, r.squawk, r.lat, r.lon, r.altitude_ft, r.speed_kt, r.heading);
    }
  });

  insertMany(dedupRows);
}

/**
 * Fetch a single adsb.fi endpoint and return parsed rows.
 * @param {string} url
 * @returns {Promise<Array>}
 */
async function _fetchAndParse(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  const data = await res.json();
  return parseFlightData(data);
}

/**
 * Perform a single poll: fetch from adsb.fi for all theaters, parse, and insert into correct DBs.
 */
async function poll() {
  try {
    // Build per-theater fetch URLs
    const theaterEntries = Object.entries(theaters);
    const fetchPromises = theaterEntries.map(([key, t]) => {
      const url = `${ADSB_FI_BASE}/lat/${t.airspaceCenterKm.lat}/lon/${t.airspaceCenterKm.lon}/dist/${t.airspaceCenterKm.radiusKm}`;
      return _fetchAndParse(url)
        .then(rows => ({ key, rows }))
        .catch(err => {
          console.error(`[flights] Fetch error for ${key}: ${err.message}`);
          return { key, rows: [] };
        });
    });

    const results = await Promise.all(fetchPromises);

    let totalCount = 0;
    for (const { key, rows } of results) {
      if (rows.length === 0) continue;

      // Route each row to correct theater by position, fallback to the fetched theater
      const theaterBuckets = {};
      for (const row of rows) {
        const theater = resolveFlightTheater(row.lat, row.lon) || key;
        if (!theaterBuckets[theater]) theaterBuckets[theater] = [];
        theaterBuckets[theater].push(row);
      }

      for (const [theaterKey, theaterRows] of Object.entries(theaterBuckets)) {
        const db = getDb(theaterKey);
        insertFlights(theaterRows, db);
        checkEmergencySquawks(theaterRows, db);
      }

      totalCount += rows.length;
    }

    _aircraftCount = totalCount;
    _lastPollAt = new Date().toISOString();

    console.log(`[flights] Inserted ${totalCount} aircraft positions across ${theaterEntries.length} theaters`);
  } catch (err) {
    console.error(`[flights] Poll error: ${err.message}`);
  }
}

/**
 * Start the periodic flight data collector.
 * @param {number} [intervalMs] - Poll interval in milliseconds (default 15 000)
 */
function start(intervalMs) {
  if (_timer) return; // already running

  _pollIntervalMs = intervalMs || DEFAULT_POLL_INTERVAL_MS;
  _polling = true;

  // Fire first poll immediately, then repeat on interval
  poll();
  _timer = setInterval(poll, _pollIntervalMs);

  console.log(`[flights] Collector started — polling every ${_pollIntervalMs / 1000}s`);
}

/**
 * Stop the periodic flight data collector.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _polling = false;
  console.log('[flights] Collector stopped');
}

/**
 * Return current collector statistics.
 * @returns {{ polling: boolean, lastPollAt: string|null, aircraftCount: number, pollInterval: number }}
 */
function getStats() {
  return {
    polling: _polling,
    lastPollAt: _lastPollAt,
    aircraftCount: _aircraftCount,
    pollInterval: _pollIntervalMs,
  };
}

module.exports = { start, stop, getStats, parseFlightData, insertFlights, checkEmergencySquawks, resolveFlightTheater };
