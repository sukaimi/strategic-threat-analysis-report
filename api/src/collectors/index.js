'use strict';

const port = require('./port');

// Optional collectors — loaded defensively so a missing file doesn't crash the manager
let ais = null;
let mpa = null;
let flights = null;
let weather = null;
let osint = null;
let nea = null;
let ofac = null;
let acled = null;
let gdelt = null;
let firms = null;

try { ais = require('./ais'); } catch (_e) { /* not yet implemented */ }
try { mpa = require('./mpa'); } catch (_e) { /* not yet implemented */ }
try { flights = require('./flights'); } catch (_e) { /* not yet implemented */ }
try { weather = require('./weather'); } catch (_e) { /* not yet implemented */ }
try { osint = require('./osint'); } catch (_e) { /* not yet implemented */ }
try { nea = require('./nea'); } catch (_e) { /* not yet implemented */ }
try { ofac = require('./ofac'); } catch (_e) { /* Sprint 2 — OFAC SDN */ }
try { acled = require('./acled'); } catch (_e) { /* Sprint 2 — ACLED conflict events */ }
try { gdelt = require('./gdelt'); } catch (_e) { /* GDELT news events */ }
try { firms = require('./firms'); } catch (_e) { /* NASA FIRMS thermal detections */ }

const collectors = { mpa, ais, flights, weather, port, osint, nea, ofac, acled, gdelt, firms };

/**
 * Start all available collectors.
 * Individual failures are caught so one broken collector cannot crash the others.
 */
function startAll() {
  for (const [name, collector] of Object.entries(collectors)) {
    if (!collector || typeof collector.start !== 'function') {
      console.log('[collectors] %s — not available, skipping', name);
      continue;
    }
    try {
      collector.start();
      console.log('[collectors] %s — started', name);
    } catch (err) {
      console.error('[collectors] %s — failed to start: %s', name, err.message);
    }
  }
}

/**
 * Stop all running collectors gracefully.
 */
function stopAll() {
  for (const [name, collector] of Object.entries(collectors)) {
    if (!collector || typeof collector.stop !== 'function') continue;
    try {
      collector.stop();
      console.log('[collectors] %s — stopped', name);
    } catch (err) {
      console.error('[collectors] %s — failed to stop: %s', name, err.message);
    }
  }
}

// Expected poll intervals per collector (ms) — used for staleness detection
const EXPECTED_INTERVALS = {
  mpa:     3 * 60 * 1000,    // 3 minutes
  ais:     30_000,            // 30 seconds (batch flush)
  flights: 15_000,            // 15 seconds
  weather: 900_000,           // 15 minutes
  port:    300_000,           // 5 minutes
};

/**
 * Normalise raw collector stats into a uniform shape:
 *   { status: 'active'|'stale'|'error'|'unavailable', lastUpdate, recordCount }
 *
 * A collector is considered "stale" when its lastUpdate is older than
 * 2x its expected poll interval.
 */
function normaliseStats(name, raw) {
  if (!raw || raw.available === false) {
    return { status: 'unavailable', lastUpdate: null, recordCount: 0 };
  }

  // Determine the last-update timestamp from whichever field the collector uses
  const lastUpdate = raw.lastMessageAt || raw.lastFetchAt || raw.lastPollAt || raw.lastSuccessAt || null;

  // Determine the record count from whichever field the collector uses
  const recordCount = raw.messagesReceived ?? raw.aircraftCount ?? raw.fetchCount ?? raw.lastVesselCount ?? 0;

  // Staleness check
  let status = 'active';
  if (!lastUpdate) {
    status = 'error';
  } else {
    const ageMs = Date.now() - new Date(lastUpdate).getTime();
    const threshold = (EXPECTED_INTERVALS[name] || 60_000) * 2;
    if (ageMs > threshold) {
      status = 'stale';
    }
  }

  // Override to error if collector reports explicit error state
  if (raw.errorCount > 0 && raw.fetchCount === 0) {
    status = 'error';
  }

  return { status, lastUpdate, recordCount };
}

/**
 * Return the status of every registered collector.
 * @returns {object} keyed by collector name, each value has { status, lastUpdate, recordCount }
 */
function getStatus() {
  const status = {};
  for (const [name, collector] of Object.entries(collectors)) {
    if (!collector || typeof collector.getStats !== 'function') {
      status[name] = normaliseStats(name, null);
    } else {
      status[name] = normaliseStats(name, { available: true, ...collector.getStats() });
    }
  }
  return status;
}

module.exports = { startAll, stopAll, getStatus };
