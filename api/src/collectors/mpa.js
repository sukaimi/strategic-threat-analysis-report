'use strict';

const { getDb } = require('../db');
const config = require('../config');
const sanctions = require('../services/sanctions');

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes (MPA updates every 3 min)
const SNAPSHOT_ENDPOINT = '/vessel/positions/1.0.0/snapshot';
const VESSEL_DETAILS_ENDPOINT = '/vessel/particulars/1.0.0';

// In-memory cache for vessel details (keyed by MMSI)
const _detailsCache = new Map();
const DETAILS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let _timer = null;
let _stopped = false;

// Stats
let _lastFetchAt = null;
let _lastVesselCount = 0;
let _totalFetches = 0;
let _errors = 0;

/**
 * Map an MPA vessel position record to our DB schema.
 */
function mapRecord(v) {
  const p = v.vesselParticulars || {};
  return {
    mmsi: p.mmsiNumber ? String(p.mmsiNumber) : null,
    lat: v.latitudeDegrees ?? null,
    lon: v.longitudeDegrees ?? null,
    speed_kt: v.speed ?? null,
    heading: (v.heading != null && v.heading !== 511) ? v.heading : null,
    vessel_name: p.vesselName ? p.vesselName.trim() : null,
    vessel_type: p.vesselType || null,
    destination: v.destination || p.destination || null,
    eta: v.eta || p.eta || null,
    cargo_type: v.cargoType || p.cargoType || null,
    flag: p.flag || p.flagState || null,
    imo_number: p.imoNumber ? String(p.imoNumber) : null,
    call_sign: p.callSign || null,
    draught: v.draught ?? p.draught ?? null,
    length: p.length ?? p.lengthOverall ?? null,
    breadth: p.breadth ?? null,
  };
}

/**
 * Fetch extended vessel details from MPA by MMSI.
 * Returns cached result if available and not expired.
 */
async function fetchVesselDetails(mmsi) {
  const cached = _detailsCache.get(mmsi);
  if (cached && (Date.now() - cached.fetchedAt) < DETAILS_CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = config.MPA_API_KEY;
  if (!apiKey) throw new Error('MPA_API_KEY not set');

  const url = `${config.MPA_BASE_URL}${VESSEL_DETAILS_ENDPOINT}?mmsiNumber=${encodeURIComponent(mmsi)}`;
  const res = await fetch(url, {
    headers: { 'apikey': apiKey, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MPA HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const details = Array.isArray(data) ? data[0] || null : data;
  _detailsCache.set(mmsi, { data: details, fetchedAt: Date.now() });
  return details;
}

/**
 * Fetch the vessel positions snapshot from MPA OCEANS-X and write to DB.
 */
async function poll() {
  const apiKey = config.MPA_API_KEY;
  if (!apiKey) {
    console.error('[MPA] MPA_API_KEY not set; skipping poll');
    return;
  }

  const url = `${config.MPA_BASE_URL}${SNAPSHOT_ENDPOINT}`;

  try {
    const res = await fetch(url, {
      headers: {
        'apikey': apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[MPA] HTTP ${res.status}: ${body.slice(0, 200)}`);
      _errors++;
      return;
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      console.error('[MPA] Unexpected response format (not an array)');
      _errors++;
      return;
    }

    const records = data.map(mapRecord).filter((r) => r.mmsi && r.lat != null && r.lon != null);

    if (records.length === 0) {
      console.warn('[MPA] No valid vessel records in snapshot');
      return;
    }

    // Write to DB
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type)
      VALUES (@mmsi, @lat, @lon, @speed_kt, @heading, @vessel_name, @vessel_type)
    `);

    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        insert.run(row);
      }
    });

    insertMany(records);

    // Screen batch against sanctions list
    try {
      const matches = sanctions.screenBatch(records);
      if (matches.length > 0) {
        const flagStmt = db.prepare('UPDATE vessels SET flagged = 1 WHERE mmsi = ?');
        const alertStmt = db.prepare(
          'INSERT INTO alerts (severity, title, description, entity_mmsi) VALUES (?, ?, ?, ?)'
        );
        for (const m of matches) {
          const hit = m.result.hits[0];
          flagStmt.run(m.mmsi);
          alertStmt.run(
            'CRITICAL',
            'Sanctions Match Detected',
            `Vessel "${m.vessel_name || m.mmsi}" matched ${hit.list_source} sanctions list (${hit.reason})`.slice(0, 500),
            m.mmsi
          );
          console.log(`[MPA] SANCTIONS MATCH: MMSI ${m.mmsi} (${hit.list_source})`);
        }
      }
    } catch (err) {
      console.error('[MPA] Sanctions screening error:', err.message);
    }

    // Geo-fence check for flagged vessels entering Singapore approach
    try {
      const geofence = require('../services/geofence');
      geofence.checkGeofence(records, db);
    } catch (err) {
      console.error('[MPA] Geofence check error:', err.message);
    }

    _lastFetchAt = new Date().toISOString();
    _lastVesselCount = records.length;
    _totalFetches++;
    console.log(`[MPA] Fetched ${records.length} vessel positions (total fetches: ${_totalFetches})`);
  } catch (err) {
    _errors++;
    if (err.name === 'TimeoutError') {
      console.error('[MPA] Request timed out');
    } else {
      console.error('[MPA] Poll error:', err.message);
    }
  }
}

function start() {
  _stopped = false;
  _totalFetches = 0;
  _errors = 0;
  _lastFetchAt = null;
  _lastVesselCount = 0;

  if (!config.MPA_API_KEY) {
    console.error('[MPA] MPA_API_KEY not set; collector will not start');
    return;
  }

  // Fetch immediately, then on interval
  poll();
  _timer = setInterval(poll, POLL_INTERVAL_MS);

  console.log('[MPA] Collector started (polling every 3 min)');
}

function stop() {
  _stopped = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  console.log('[MPA] Collector stopped');
}

function getStats() {
  return {
    connected: !_stopped && !!config.MPA_API_KEY,
    lastFetchAt: _lastFetchAt,
    lastVesselCount: _lastVesselCount,
    totalFetches: _totalFetches,
    errors: _errors,
  };
}

module.exports = { start, stop, getStats, fetchVesselDetails };
