'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// OpenSanctions API cache (Sprint 2 — DJINN enrichment)
// Caches results for 24 hours to respect rate limits.
// ---------------------------------------------------------------------------
const _openSanctionsCache = new Map(); // key: normalisedName -> { result, fetchedAt }
const OPENSANCTIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// In-memory sanctions index
// ---------------------------------------------------------------------------

const _byMmsi = new Map();
const _byImo = new Map();
const _byName = new Map(); // normalised vessel name -> entry
const _allNames = [];       // for fuzzy matching

let _loadedAt = null;
let _entityCount = 0;

// High-risk flag states (flags of convenience often used for sanctions evasion)
// High-risk flag states: original MERLION set + DJINN expansion (Palau, Togo, Djibouti, Gabon, Eq. Guinea, Kiribati)
const HIGH_RISK_FLAGS = new Set(['PA', 'LR', 'MH', 'CM', 'TZ', 'KM', 'PW', 'TG', 'DJ', 'GA', 'GQ', 'KI']);

/**
 * Normalise a vessel name for matching:
 * uppercase, collapse whitespace, strip punctuation.
 */
function normaliseName(name) {
  if (!name) return '';
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute Levenshtein distance between two strings.
 * Simple Wagner-Fischer implementation — no external dependencies.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Check if name fuzzy-matches any sanctioned vessel name.
 * Threshold: edit distance <= max(2, 15% of name length).
 * @param {string} normName - normalised vessel name
 * @returns {object|null} matching sanctions entry or null
 */
function fuzzyMatchName(normName) {
  if (!normName || normName.length < 3) return null;

  const maxDist = Math.max(2, Math.floor(normName.length * 0.15));
  let bestEntry = null;
  let bestDist = Infinity;

  for (const { name, entry } of _allNames) {
    const dist = levenshtein(normName, name);
    if (dist <= maxDist && dist < bestDist) {
      bestDist = dist;
      bestEntry = entry;
      if (dist === 0) break; // exact match
    }
  }

  return bestEntry;
}

/**
 * Load seed data from the static JSON file.
 * Called once at module load; can be called again to refresh.
 */
function load(seedPath) {
  const filePath =
    seedPath ||
    path.resolve(__dirname, '../../data/sanctions/seed.json');

  if (!fs.existsSync(filePath)) {
    console.warn('[sanctions] Seed file not found at', filePath);
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const entries = JSON.parse(raw);

  // Clear existing maps
  _byMmsi.clear();
  _byImo.clear();
  _byName.clear();
  _allNames.length = 0;

  for (const entry of entries) {
    if (entry.mmsi) _byMmsi.set(String(entry.mmsi), entry);
    if (entry.imo) _byImo.set(String(entry.imo), entry);
    if (entry.vessel_name) {
      const norm = normaliseName(entry.vessel_name);
      _byName.set(norm, entry);
      _allNames.push({ name: norm, entry });
    }
  }

  _entityCount = entries.length;
  _loadedAt = new Date().toISOString();
  console.log(`[sanctions] Loaded ${_entityCount} sanctioned entities`);
}

// ---------------------------------------------------------------------------
// Flag-state risk scoring
// ---------------------------------------------------------------------------

/**
 * Returns a risk score based on the vessel's flag state.
 * @param {string} flagState - ISO 2-letter country code
 * @returns {{ risk: 'high'|'normal', flag_state: string }}
 */
function flagRisk(flagState) {
  if (!flagState) return { risk: 'normal', flag_state: flagState || 'unknown' };
  return {
    risk: HIGH_RISK_FLAGS.has(flagState.toUpperCase()) ? 'high' : 'normal',
    flag_state: flagState.toUpperCase(),
  };
}

// ---------------------------------------------------------------------------
// OpenSanctions API lookup (Sprint 2 — optional)
// ---------------------------------------------------------------------------

/**
 * Query the OpenSanctions API for fuzzy vessel name matches.
 * Only called when OPENSANCTIONS_API_KEY env var is set and the vessel
 * did not match the local list.
 *
 * Results are cached for 24 hours per vessel name.
 *
 * @param {string} vesselName - Original vessel name
 * @returns {Promise<object|null>} matching entry or null
 */
async function queryOpenSanctions(vesselName) {
  let apiKey;
  try {
    apiKey = require('../config').OPENSANCTIONS_API_KEY;
  } catch (_) {
    return null;
  }

  if (!apiKey) return null;

  const norm = normaliseName(vesselName);
  if (!norm || norm.length < 3) return null;

  // Check cache
  const cached = _openSanctionsCache.get(norm);
  if (cached && (Date.now() - cached.fetchedAt) < OPENSANCTIONS_CACHE_TTL_MS) {
    return cached.result;
  }

  let baseUrl;
  try {
    baseUrl = require('../config').OPENSANCTIONS_BASE_URL || 'https://api.opensanctions.org';
  } catch (_) {
    baseUrl = 'https://api.opensanctions.org';
  }

  const url = `${baseUrl}/search/default?q=${encodeURIComponent(vesselName)}&limit=5`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      headers: {
        'Authorization': `ApiKey ${apiKey}`,
        'User-Agent': 'STAR-MERLION/2.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn('[sanctions] OpenSanctions API returned HTTP %d', res.status);
      _openSanctionsCache.set(norm, { result: null, fetchedAt: Date.now() });
      return null;
    }

    const json = await res.json();
    const results = json.results || [];

    // Look for vessel/ship matches with reasonable score
    for (const r of results) {
      if (r.score && r.score > 0.7) {
        const entry = {
          vessel_name: r.caption || r.name || vesselName,
          list_source: 'OpenSanctions',
          reason: `OpenSanctions match (score: ${r.score.toFixed(2)}) — ${(r.datasets || []).join(', ')}`,
          schema: r.schema || '',
        };
        _openSanctionsCache.set(norm, { result: entry, fetchedAt: Date.now() });
        return entry;
      }
    }

    _openSanctionsCache.set(norm, { result: null, fetchedAt: Date.now() });
    return null;
  } catch (err) {
    console.warn('[sanctions] OpenSanctions query failed: %s', err.message);
    _openSanctionsCache.set(norm, { result: null, fetchedAt: Date.now() });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

/**
 * Screen a single vessel against the sanctions list.
 *
 * @param {{ mmsi?: string, imo?: string, vessel_name?: string, flag_state?: string }} vessel
 * @returns {{ matched: boolean, hits: object[], flag_risk: object }}
 */
function screenVessel(vessel) {
  const hits = [];

  if (vessel.mmsi) {
    const entry = _byMmsi.get(String(vessel.mmsi));
    if (entry) hits.push({ match_field: 'mmsi', match_type: 'exact', ...entry });
  }

  if (vessel.imo) {
    const entry = _byImo.get(String(vessel.imo));
    if (entry && !hits.some((h) => h.mmsi === entry.mmsi)) {
      hits.push({ match_field: 'imo', match_type: 'exact', ...entry });
    }
  }

  if (vessel.vessel_name) {
    const norm = normaliseName(vessel.vessel_name);
    if (norm) {
      // Exact name match first
      const exactEntry = _byName.get(norm);
      if (exactEntry && !hits.some((h) => h.mmsi === exactEntry.mmsi)) {
        hits.push({ match_field: 'vessel_name', match_type: 'exact', ...exactEntry });
      } else if (!exactEntry) {
        // Fuzzy match
        const fuzzyEntry = fuzzyMatchName(norm);
        if (fuzzyEntry && !hits.some((h) => h.mmsi === fuzzyEntry.mmsi)) {
          hits.push({ match_field: 'vessel_name', match_type: 'fuzzy', ...fuzzyEntry });
        }
      }
    }
  }

  const fr = flagRisk(vessel.flag_state);

  return { matched: hits.length > 0, hits, flag_risk: fr };
}

/**
 * Screen a single vessel with optional OpenSanctions fallback (async).
 * Falls back to OpenSanctions API when local screening finds no match
 * and OPENSANCTIONS_API_KEY is configured.
 *
 * @param {{ mmsi?: string, imo?: string, vessel_name?: string, flag_state?: string }} vessel
 * @returns {Promise<{ matched: boolean, hits: object[], flag_risk: object }>}
 */
async function screenVesselAsync(vessel) {
  const result = screenVessel(vessel);

  // If already matched locally, return immediately
  if (result.matched) return result;

  // Try OpenSanctions if vessel has a name and API key is configured
  if (vessel.vessel_name) {
    const osEntry = await queryOpenSanctions(vessel.vessel_name);
    if (osEntry) {
      result.hits.push({
        match_field: 'vessel_name',
        match_type: 'opensanctions',
        ...osEntry,
      });
      result.matched = true;
    }
  }

  return result;
}

/**
 * Screen a batch of vessel records and return only matches.
 *
 * @param {object[]} vessels
 * @returns {{ mmsi: string, result: { matched: true, hits: object[] } }[]}
 */
function screenBatch(vessels) {
  const matches = [];
  for (const v of vessels) {
    const result = screenVessel(v);
    if (result.matched) {
      matches.push({ mmsi: v.mmsi, vessel_name: v.vessel_name, result });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function getStats() {
  return {
    entityCount: _entityCount,
    lastRefresh: _loadedAt,
    indexSizes: {
      byMmsi: _byMmsi.size,
      byImo: _byImo.size,
      byName: _byName.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh stub for future automated refresh
// ---------------------------------------------------------------------------

/**
 * Stub for automated refresh from an external URL.
 * In the future, this will fetch an updated sanctions list and reload.
 * @param {string} url - URL to fetch updated sanctions data from
 * @returns {Promise<{ refreshed: boolean, message: string }>}
 */
async function refreshFromUrl(url) {
  // Stub — not yet implemented
  console.log(`[sanctions] refreshFromUrl called with: ${url} (stub — not yet implemented)`);
  return { refreshed: false, message: 'refreshFromUrl is a stub — automated refresh not yet implemented' };
}

// ---------------------------------------------------------------------------
// Auto-load on first require
// ---------------------------------------------------------------------------

load();

module.exports = {
  load,
  screenVessel,
  screenVesselAsync,
  screenBatch,
  getStats,
  normaliseName,
  levenshtein,
  fuzzyMatchName,
  flagRisk,
  refreshFromUrl,
  queryOpenSanctions,
  HIGH_RISK_FLAGS,
};
