'use strict';

/**
 * GDELT (Global Database of Events, Language, and Tone) collector.
 *
 * Fetches geolocated news events relevant to the Strait of Hormuz / Persian Gulf
 * and inserts them as intel_articles in the DJINN DB.
 *
 * No API key required. Polls every 30 minutes.
 * Optional: only runs if config.GDELT_ENABLED is true (default true).
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
  articleCount: 0,
  lastError: null,
};

// Default query: Hormuz-relevant keywords, last 24 hours, max 50 articles
const GDELT_DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERY = 'hormuz OR "persian gulf" OR iran naval OR "strait of hormuz" OR IRGC maritime';

/**
 * Compute a dedup hash from a URL.
 */
function dedupHash(url) {
  return crypto.createHash('sha256').update(`gdelt:${url}`).digest('hex');
}

/**
 * Parse GDELT DOC API JSON response into normalized article objects.
 * @param {object} json - Raw GDELT response
 * @returns {Array<{title: string, url: string, date: string, source: string, tone: number, language: string}>}
 */
function parseArticles(json) {
  const articles = [];
  const items = json?.articles || [];

  for (const item of items) {
    if (!item.url || !item.title) continue;
    articles.push({
      title: item.title || '',
      url: item.url || '',
      date: item.seendate || '',
      source: item.domain || item.sourcecountry || 'unknown',
      tone: parseFloat(item.tone) || 0,
      language: item.language || 'English',
    });
  }

  return articles;
}

/**
 * Fetch GDELT articles and insert into DJINN DB as intel_articles.
 */
async function _refresh() {
  const params = new URLSearchParams({
    query: GDELT_QUERY,
    mode: 'artlist',
    maxrecords: '50',
    format: 'json',
    timespan: '1440', // last 24 hours in minutes
  });

  const url = `${GDELT_DOC_URL}?${params.toString()}`;
  console.log('[gdelt] Fetching news events for Hormuz/Persian Gulf');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from GDELT API`);
    }

    const json = await res.json();
    const articles = parseArticles(json);

    if (articles.length === 0) {
      _stats.lastFetchAt = new Date().toISOString();
      _stats.fetchCount++;
      return;
    }

    // Get DJINN DB
    let db;
    try {
      db = getDb('djinn');
    } catch (err) {
      console.error('[gdelt] Cannot open DJINN DB: %s', err.message);
      return;
    }

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO intel_articles
       (source, guid, title, link, summary, published_at, relevance_score, entities_json, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let inserted = 0;

    for (const article of articles) {
      const hash = dedupHash(article.url);

      // Check dedup
      const exists = db.prepare('SELECT 1 FROM intel_articles WHERE dedup_hash = ?').get(hash);
      if (exists) continue;

      // Build summary with tone score
      const summary = [
        `Source: ${article.source}`,
        `Language: ${article.language}`,
        `Tone: ${article.tone > 0 ? '+' : ''}${article.tone.toFixed(1)}`,
      ].join(' | ');

      // Assign relevance based on tone magnitude (stronger tone = more noteworthy)
      let relevance = 35;
      const absTone = Math.abs(article.tone);
      if (absTone > 5) relevance += 15;
      if (absTone > 10) relevance += 10;

      // Boost for highly relevant keywords in title
      const lowerTitle = article.title.toLowerCase();
      if (/hormuz|strait|seizure|irgc|tanker|naval/.test(lowerTitle)) {
        relevance += 20;
      }
      if (/attack|strike|missile|drone|mine|hijack/.test(lowerTitle)) {
        relevance += 15;
      }

      const entities = {
        source: article.source,
        tone: article.tone,
        language: article.language,
      };

      // Parse GDELT date format (YYYYMMDDTHHMMSSZ) to ISO
      let publishedAt = article.date;
      if (publishedAt && /^\d{14}$/.test(publishedAt.replace(/[TZ]/g, ''))) {
        try {
          const d = publishedAt.replace(/(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?/,
            '$1-$2-$3T$4:$5:$6Z');
          publishedAt = new Date(d).toISOString();
        } catch (_) { /* keep original */ }
      }

      const info = insertStmt.run(
        'GDELT',
        article.url,
        article.title.slice(0, 500),
        article.url,
        summary.slice(0, 2000),
        publishedAt || null,
        relevance,
        JSON.stringify(entities),
        hash
      );

      if (info.changes > 0) inserted++;
    }

    _stats.lastFetchAt = new Date().toISOString();
    _stats.fetchCount++;
    _stats.articleCount += inserted;

    if (inserted > 0) {
      console.log('[gdelt] Ingested %d new articles from %d total', inserted, articles.length);
    }
  } catch (err) {
    _stats.errorCount++;
    _stats.lastError = err.message;
    console.error('[gdelt] Fetch error: %s', err.message);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function start() {
  if (_timer) return;

  // Check if GDELT is enabled (default: true)
  const enabled = config.GDELT_ENABLED !== false && config.GDELT_ENABLED !== 'false';
  if (!enabled) {
    console.log('[gdelt] GDELT_ENABLED is false — collector disabled');
    return;
  }

  const intervalMs = config.GDELT_REFRESH_INTERVAL_MS || DEFAULT_INTERVAL_MS;
  console.log('[gdelt] collector started — refreshing every %d min', intervalMs / 60000);
  _refresh();
  _timer = setInterval(_refresh, intervalMs);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[gdelt] collector stopped');
  }
}

function getStats() {
  return { ..._stats };
}

module.exports = { start, stop, getStats, dedupHash, parseArticles };
