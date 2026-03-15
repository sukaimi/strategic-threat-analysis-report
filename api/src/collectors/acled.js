'use strict';

/**
 * ACLED (Armed Conflict Location & Event Data) collector.
 *
 * Fetches conflict events near the Strait of Hormuz (Iran, Oman, UAE)
 * and inserts relevant events as intel_articles in the DJINN DB.
 *
 * Sprint 2 — DJINN enrichment: optional, only runs if ACLED_API_KEY is set.
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
  eventCount: 0,
  lastError: null,
};

// ISO country codes for Iran (364), Oman (512), UAE (784)
const COUNTRY_ISOS = '364|512|784';

// Event types we care about for maritime/strategic relevance
const RELEVANT_EVENT_TYPES = new Set([
  'Battles',
  'Strategic developments',
  'Violence against civilians',
  'Explosions/Remote violence',
]);

/**
 * Compute a dedup hash for an ACLED event.
 */
function dedupHash(eventId) {
  return crypto.createHash('sha256').update(`acled:${eventId}`).digest('hex');
}

/**
 * Build the date filter for the last 30 days.
 */
function dateFilter() {
  const now = new Date();
  const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return past.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Fetch ACLED events and insert into DJINN DB as intel_articles.
 */
async function _refresh() {
  if (!config.ACLED_API_KEY) {
    // Silently skip if no API key configured
    return;
  }

  const baseUrl = config.ACLED_BASE_URL || 'https://api.acleddata.com/acled/read';
  const params = new URLSearchParams({
    key: config.ACLED_API_KEY,
    email: config.ACLED_API_EMAIL || '',
    iso: COUNTRY_ISOS,
    limit: '100',
    event_date: `${dateFilter()}|${new Date().toISOString().slice(0, 10)}`,
    event_date_where: 'BETWEEN',
  });

  const url = `${baseUrl}?${params.toString()}`;
  console.log('[acled] Fetching conflict events for Iran/Oman/UAE (last 30 days)');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ACLED API`);
    }

    const json = await res.json();
    const events = json.data || [];

    if (!Array.isArray(events)) {
      throw new Error('Unexpected ACLED response format');
    }

    // Get DJINN DB
    let db;
    try {
      db = getDb('djinn');
    } catch (err) {
      console.error('[acled] Cannot open DJINN DB: %s', err.message);
      return;
    }

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO intel_articles
       (source, guid, title, link, summary, published_at, relevance_score, entities_json, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;

    for (const event of events) {
      const eventType = event.event_type || '';

      // Filter for relevant event types
      if (!RELEVANT_EVENT_TYPES.has(eventType)) continue;

      const eventId = event.data_id || event.event_id_cnty || `${event.event_date}-${event.country}-${inserted}`;
      const hash = dedupHash(eventId);

      // Check dedup
      const exists = db.prepare('SELECT 1 FROM intel_articles WHERE dedup_hash = ?').get(hash);
      if (exists) continue;

      const title = `[ACLED] ${eventType}: ${event.sub_event_type || ''} — ${event.country || ''}`.trim();
      const summary = [
        event.notes || '',
        `Location: ${event.location || ''}, ${event.admin1 || ''}`,
        `Actors: ${event.actor1 || ''} vs ${event.actor2 || ''}`,
        event.fatalities ? `Fatalities: ${event.fatalities}` : '',
      ].filter(Boolean).join(' | ');

      const entities = {
        locations: [event.location, event.admin1, event.country].filter(Boolean),
        actors: [event.actor1, event.actor2].filter(Boolean),
      };

      // Assign relevance score based on event type
      let relevance = 30;
      if (eventType === 'Battles') relevance = 60;
      if (eventType === 'Strategic developments') relevance = 50;
      if (eventType === 'Explosions/Remote violence') relevance = 55;

      // Boost if maritime-related keywords appear
      const lowerNotes = (event.notes || '').toLowerCase();
      if (/maritime|naval|vessel|tanker|ship|port|hormuz|gulf/.test(lowerNotes)) {
        relevance += 20;
      }

      const info = insertStmt.run(
        'ACLED',
        String(eventId),
        title,
        '', // ACLED doesn't provide article links
        summary.slice(0, 2000),
        event.event_date || null,
        relevance,
        JSON.stringify(entities),
        hash
      );

      if (info.changes > 0) inserted++;
    }

    _stats.lastFetchAt = new Date().toISOString();
    _stats.fetchCount++;
    _stats.eventCount += inserted;

    if (inserted > 0) {
      console.log('[acled] Ingested %d new conflict events from %d total', inserted, events.length);
    }
  } catch (err) {
    _stats.errorCount++;
    _stats.lastError = err.message;
    console.error('[acled] Fetch error: %s', err.message);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

function start() {
  if (_timer) return;
  if (!config.ACLED_API_KEY) {
    console.log('[acled] No ACLED_API_KEY configured — collector disabled');
    return;
  }
  const intervalMs = config.ACLED_REFRESH_INTERVAL_MS || 86400000;
  console.log('[acled] collector started — refreshing every %d hours', intervalMs / 3600000);
  _refresh();
  _timer = setInterval(_refresh, intervalMs);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[acled] collector stopped');
  }
}

function getStats() {
  return { ..._stats };
}

module.exports = { start, stop, getStats, dedupHash };
