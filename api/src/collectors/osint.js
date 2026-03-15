'use strict';

const crypto = require('node:crypto');
const { XMLParser } = require('fast-xml-parser');
const config = require('../config');
const { getDb } = require('../db');
const theaters = require('../theaters');
const { extractEntities, scoreRelevance } = require('../services/entityExtractor');
const { events } = require('../services/bridge');

const USER_AGENT = 'STAR-MERLION/2.0 (maritime-intelligence-system)';

let _timer = null;
let _stats = {
  lastFetchAt: null,
  fetchCount: 0,
  errorCount: 0,
  articleCount: 0,
  lastError: null,
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// ---------------------------------------------------------------------------
// Feed parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse feed URLs from the config string.
 * @returns {string[]}
 */
function getFeedUrls() {
  if (Array.isArray(config.OSINT_RSS_FEEDS)) return config.OSINT_RSS_FEEDS;
  return config.OSINT_RSS_FEEDS.split(',').map(u => u.trim()).filter(Boolean);
}

/**
 * Derive the source name from a feed URL.
 * @param {string} url
 * @returns {string}
 */
function sourceFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname.split('.')[0];
  } catch {
    return 'unknown';
  }
}

/**
 * Compute SHA-256 dedup hash from source + guid.
 * @param {string} source
 * @param {string} guid
 * @returns {string}
 */
function dedupHash(source, guid) {
  return crypto.createHash('sha256').update(`${source}:${guid}`).digest('hex');
}

/**
 * Normalize RSS 2.0 and Atom items into a flat array.
 * @param {object} parsed - Parsed XML object
 * @returns {Array<{guid: string, title: string, link: string, summary: string, published_at: string}>}
 */
function normalizeItems(parsed) {
  const items = [];

  // RSS 2.0: rss.channel.item
  const rssItems = parsed?.rss?.channel?.item;
  if (rssItems) {
    const arr = Array.isArray(rssItems) ? rssItems : [rssItems];
    for (const item of arr) {
      items.push({
        guid: item.guid?.['#text'] || item.guid || item.link || '',
        title: item.title || '',
        link: item.link || '',
        summary: item.description || item['content:encoded'] || '',
        published_at: item.pubDate || item['dc:date'] || '',
      });
    }
    return items;
  }

  // Atom: feed.entry
  const atomEntries = parsed?.feed?.entry;
  if (atomEntries) {
    const arr = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    for (const entry of arr) {
      const link = entry.link?.['@_href'] || (Array.isArray(entry.link) ? entry.link[0]?.['@_href'] : '') || '';
      items.push({
        guid: entry.id || link || '',
        title: entry.title?.['#text'] || entry.title || '',
        link,
        summary: entry.summary?.['#text'] || entry.summary || entry.content?.['#text'] || entry.content || '',
        published_at: entry.published || entry.updated || '',
      });
    }
    return items;
  }

  return items;
}

/**
 * Strip HTML tags from a string for plain-text processing.
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main fetch logic
// ---------------------------------------------------------------------------

/**
 * Check whether article text matches a theater's OSINT keywords.
 * @param {string} text - lowercased combined title + summary
 * @param {string} theaterKey
 * @returns {boolean}
 */
function matchesTheater(text, theaterKey) {
  const t = theaters[theaterKey];
  if (!t || !t.osintKeywords) return false;
  return t.osintKeywords.some(kw => text.includes(kw));
}

/**
 * Fetch and process a single RSS feed.
 * Inserts into the default (merlion) DB, and also mirrors to other theater DBs
 * when article text matches that theater's OSINT keywords.
 * @param {string} feedUrl
 * @returns {Promise<number>} number of new articles inserted (across all theaters)
 */
async function fetchFeed(feedUrl) {
  const source = sourceFromUrl(feedUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let xml;
  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${feedUrl}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const parsed = xmlParser.parse(xml);
  const feedItems = normalizeItems(parsed);

  // Primary DB (merlion)
  const db = getDb();
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO intel_articles
     (source, guid, title, link, summary, published_at, relevance_score, entities_json, dedup_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Prepare insert statements for other theaters
  const otherTheaters = Object.keys(theaters).filter(k => k !== 'merlion');
  const otherStmts = {};
  for (const tk of otherTheaters) {
    try {
      const tdb = getDb(tk);
      otherStmts[tk] = {
        db: tdb,
        insert: tdb.prepare(
          `INSERT OR IGNORE INTO intel_articles
           (source, guid, title, link, summary, published_at, relevance_score, entities_json, dedup_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ),
        dedup: tdb.prepare('SELECT 1 FROM intel_articles WHERE dedup_hash = ?'),
      };
    } catch (err) {
      console.error(`[osint] Failed to prepare DB for ${tk}: ${err.message}`);
    }
  }

  let inserted = 0;

  for (const item of feedItems) {
    const guid = item.guid || item.link || item.title;
    if (!guid) continue;

    const hash = dedupHash(source, guid);

    // Quick dedup check before doing more work
    const exists = db.prepare('SELECT 1 FROM intel_articles WHERE dedup_hash = ?').get(hash);
    if (exists) continue;

    const plainTitle = stripHtml(item.title);
    const plainSummary = stripHtml(item.summary).slice(0, 2000); // Cap summary length
    const combinedText = `${plainTitle} ${plainSummary}`;
    const lowerText = combinedText.toLowerCase();

    const entities = extractEntities(combinedText);
    const relevance = scoreRelevance(
      { title: plainTitle, summary: plainSummary, published_at: item.published_at },
      entities
    );

    // Only store articles meeting minimum relevance
    if (relevance < config.OSINT_MIN_RELEVANCE) continue;

    const entitiesJson = JSON.stringify(entities);
    const params = [
      source, guid, plainTitle, item.link, plainSummary,
      item.published_at || null, relevance, entitiesJson, hash
    ];

    const info = insertStmt.run(...params);

    if (info.changes > 0) {
      inserted++;

      // Also insert into other theater DBs if keywords match
      for (const tk of otherTheaters) {
        if (matchesTheater(lowerText, tk) && otherStmts[tk]) {
          try {
            const existsOther = otherStmts[tk].dedup.get(hash);
            if (!existsOther) {
              otherStmts[tk].insert.run(...params);
              inserted++;
            }
          } catch (err) {
            console.error(`[osint] Insert to ${tk} failed: ${err.message}`);
          }
        }
      }

      // Real-time OSINT-to-AIS correlation (Item 20):
      // If article has high relevance and mentions vessels currently in our feed, generate alert
      if (relevance >= 60) {
        _correlateOsintToAIS(db, { source, title: plainTitle, entities, relevance });
        // Also check other theater DBs
        for (const tk of otherTheaters) {
          if (matchesTheater(lowerText, tk) && otherStmts[tk]) {
            try { _correlateOsintToAIS(otherStmts[tk].db, { source, title: plainTitle, entities, relevance }); } catch (_) {}
          }
        }
      }

      // Emit high-relevance articles via bridge
      if (relevance >= config.OSINT_AI_MIN_RELEVANCE) {
        events.emit('intel', {
          source,
          title: plainTitle,
          link: item.link,
          relevance_score: relevance,
          entities,
          published_at: item.published_at,
        });
      }
    }
  }

  return inserted;
}

/**
 * Real-time OSINT-to-AIS correlation: check if extracted entities match
 * any vessel currently in the database and generate an alert if so.
 * @param {import('better-sqlite3').Database} db
 * @param {{ source: string, title: string, entities: object, relevance: number }} article
 */
function _correlateOsintToAIS(db, { source, title, entities, relevance }) {
  if (!entities) return;

  // Get currently tracked vessels (last 5 min)
  let vessels;
  try {
    vessels = db.prepare(
      `SELECT DISTINCT mmsi, vessel_name FROM vessels
       WHERE recorded_at >= datetime('now', '-5 minutes') AND mmsi IS NOT NULL`
    ).all();
  } catch (_) { return; }

  if (!vessels || vessels.length === 0) return;

  const vesselMmsis = new Set(vessels.map(v => v.mmsi));
  const vesselNameMap = new Map();
  for (const v of vessels) {
    if (v.vessel_name) vesselNameMap.set(v.vessel_name.toUpperCase().trim(), v.mmsi);
  }

  const matchedMmsis = new Set();

  // Match by MMSI
  for (const m of (entities.mmsis || [])) {
    if (vesselMmsis.has(m)) matchedMmsis.add(m);
  }

  // Match by vessel name
  for (const name of (entities.vesselNames || [])) {
    const mmsi = vesselNameMap.get(name.toUpperCase().trim());
    if (mmsi) matchedMmsis.add(mmsi);
  }

  // Generate alerts for matches
  for (const mmsi of matchedMmsis) {
    const vesselName = vessels.find(v => v.mmsi === mmsi)?.vessel_name || mmsi;
    const alertTitle = `OSINT correlation: ${vesselName} mentioned in ${source}`;
    const description = `Article: "${title}" (relevance: ${relevance}). Vessel MMSI ${mmsi} is currently active in AIS feed.`;

    try {
      // Dedup: check if a similar alert exists recently
      const existing = db.prepare(
        `SELECT 1 FROM alerts WHERE title = ? AND entity_mmsi = ? AND created_at >= datetime('now', '-30 minutes') LIMIT 1`
      ).get(alertTitle, mmsi);
      if (existing) continue;

      db.prepare(
        `INSERT INTO alerts (severity, title, description, entity_mmsi, category) VALUES (?, ?, ?, ?, ?)`
      ).run('MEDIUM', alertTitle, description, mmsi, 'SECURITY');

      // Emit alert via bridge for real-time WS push
      events.emit('alert', { severity: 'MEDIUM', title: alertTitle, description, entity_mmsi: mmsi, category: 'SECURITY' });
    } catch (err) {
      console.error('[osint] OSINT-AIS correlation alert failed:', err.message);
    }
  }
}

/**
 * Poll all configured feeds.
 */
async function _poll() {
  const feeds = getFeedUrls();
  let totalInserted = 0;

  for (const feedUrl of feeds) {
    try {
      const count = await fetchFeed(feedUrl);
      totalInserted += count;
    } catch (err) {
      _stats.errorCount++;
      _stats.lastError = `${sourceFromUrl(feedUrl)}: ${err.message}`;
      console.error('[osint] Feed error (%s): %s', feedUrl, err.message);
    }
  }

  _stats.lastFetchAt = new Date().toISOString();
  _stats.fetchCount++;
  _stats.articleCount += totalInserted;

  if (totalInserted > 0) {
    console.log('[osint] Ingested %d new articles from %d feeds', totalInserted, feeds.length);
  }
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

function start() {
  if (_timer) return;
  console.log('[osint] collector started – polling every %d min', config.OSINT_POLL_INTERVAL_MS / 60000);
  _poll();
  _timer = setInterval(_poll, config.OSINT_POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[osint] collector stopped');
  }
}

function getStats() {
  return { ..._stats };
}

module.exports = { start, stop, getStats, fetchFeed, normalizeItems, stripHtml, dedupHash };
