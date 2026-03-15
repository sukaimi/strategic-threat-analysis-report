'use strict';

/**
 * OFAC SDN Vessel Watchlist collector.
 *
 * Downloads the OFAC Specially Designated Nationals (SDN) CSV on a daily
 * schedule, parses vessel entries (those with IMO numbers or vessel type
 * identifiers), and merges them into the in-memory sanctions index used
 * by api/src/services/sanctions.js.
 *
 * Sprint 2 — DJINN enrichment: replaces the static 53-entry seed list
 * with the full OFAC SDN (thousands of entries).
 */

const config = require('../config');
const sanctions = require('../services/sanctions');

const USER_AGENT = 'STAR-MERLION/2.0 (maritime-intelligence-system)';

let _timer = null;
let _stats = {
  lastFetchAt: null,
  fetchCount: 0,
  errorCount: 0,
  vesselCount: 0,
  lastError: null,
};

// ---------------------------------------------------------------------------
// CSV parsing helpers
// ---------------------------------------------------------------------------

/**
 * Naive CSV line splitter that respects quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse OFAC SDN CSV text and extract vessel entries.
 *
 * The SDN CSV columns (simplified):
 *   0: ent_num  1: SDN_Name  2: SDN_Type  3: Program  4: Title
 *   5: Call_Sign  6: Vess_Type  7: Tonnage  8: GRT  9: Vess_Flag
 *   10: Vess_Owner  11: Remarks
 *
 * We look for rows where SDN_Type contains "vessel" or Vess_Type is non-empty,
 * or where Remarks contain an IMO number.
 *
 * @param {string} csv - Raw CSV text from OFAC
 * @returns {Array<{vessel_name: string, imo?: string, mmsi?: string, flag_state?: string, list_source: string, reason: string}>}
 */
function parseVessels(csv) {
  const lines = csv.split(/\r?\n/);
  const vessels = [];
  const imoRegex = /IMO\s*(\d{7})/i;
  const mmsiRegex = /MMSI\s*(\d{9})/i;

  for (const line of lines) {
    if (!line.trim()) continue;

    const fields = splitCsvLine(line);
    if (fields.length < 6) continue;

    const sdnName = fields[1] || '';
    const sdnType = (fields[2] || '').toLowerCase();
    const program = fields[3] || '';
    const callSign = fields[5] || '';
    const vessType = fields[6] || '';
    const vessFlag = fields[9] || '';
    const remarks = fields[11] || '';

    // Identify vessel rows
    const isVessel =
      sdnType.includes('vessel') ||
      vessType.length > 0 ||
      callSign.length > 0 ||
      imoRegex.test(remarks);

    if (!isVessel) continue;

    const entry = {
      vessel_name: sdnName,
      list_source: 'OFAC-SDN',
      reason: `OFAC SDN — Program: ${program}`,
    };

    // Extract IMO from remarks
    const imoMatch = remarks.match(imoRegex);
    if (imoMatch) entry.imo = imoMatch[1];

    // Extract MMSI from remarks
    const mmsiMatch = remarks.match(mmsiRegex);
    if (mmsiMatch) entry.mmsi = mmsiMatch[1];

    // Flag state (2-letter ISO from OFAC field)
    if (vessFlag) entry.flag_state = vessFlag.substring(0, 2).toUpperCase();

    vessels.push(entry);
  }

  return vessels;
}

// ---------------------------------------------------------------------------
// Fetch + merge
// ---------------------------------------------------------------------------

/**
 * Fetch the OFAC SDN CSV, parse vessel entries, and merge into the sanctions
 * screening index.
 */
async function _refresh() {
  const url = config.OFAC_SDN_URL;
  if (!url) {
    console.log('[ofac] No OFAC_SDN_URL configured — skipping');
    return;
  }

  console.log('[ofac] Fetching OFAC SDN list from %s', url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from OFAC SDN endpoint`);
    }

    const csv = await res.text();
    const vessels = parseVessels(csv);

    _stats.vesselCount = vessels.length;
    _stats.lastFetchAt = new Date().toISOString();
    _stats.fetchCount++;

    if (vessels.length > 0) {
      // Merge into sanctions module — reload with combined list
      const path = require('path');
      const fs = require('fs');
      const seedPath = path.resolve(__dirname, '../../data/sanctions/seed.json');
      let seedEntries = [];
      try {
        seedEntries = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
      } catch (_) {
        // seed file may not exist
      }

      // Build a dedup set of existing IMOs and vessel names
      const existingImos = new Set(seedEntries.filter(e => e.imo).map(e => String(e.imo)));
      const existingNames = new Set(seedEntries.filter(e => e.vessel_name).map(e => e.vessel_name.toUpperCase()));

      let added = 0;
      for (const v of vessels) {
        const hasImo = v.imo && existingImos.has(String(v.imo));
        const hasName = v.vessel_name && existingNames.has(v.vessel_name.toUpperCase());
        if (!hasImo && !hasName) {
          seedEntries.push(v);
          if (v.imo) existingImos.add(String(v.imo));
          if (v.vessel_name) existingNames.add(v.vessel_name.toUpperCase());
          added++;
        }
      }

      // Reload the sanctions module with the combined list
      sanctions.load(seedPath); // re-read from disk (seed file)
      // Then add the OFAC-only entries via direct injection
      // We call load again after writing a temp combined file — or we just
      // re-export a merge function. Simpler: write combined to a temp location
      // and reload.
      if (added > 0) {
        const tmpPath = path.resolve(__dirname, '../../data/sanctions/_ofac_merged.json');
        const dir = path.dirname(tmpPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(seedEntries, null, 2));
        sanctions.load(tmpPath);
        console.log('[ofac] Merged %d new OFAC SDN vessels (total watchlist: %d)', added, seedEntries.length);
      } else {
        console.log('[ofac] No new vessels to add from OFAC SDN (%d already known)', vessels.length);
      }
    } else {
      console.log('[ofac] No vessel entries found in SDN CSV');
    }
  } catch (err) {
    _stats.errorCount++;
    _stats.lastError = err.message;
    console.error('[ofac] Fetch error: %s', err.message);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

function start() {
  if (_timer) return;
  const intervalMs = config.OFAC_REFRESH_INTERVAL_MS || 86400000;
  console.log('[ofac] collector started — refreshing every %d hours', intervalMs / 3600000);
  _refresh();
  _timer = setInterval(_refresh, intervalMs);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[ofac] collector stopped');
  }
}

function getStats() {
  return { ..._stats };
}

module.exports = { start, stop, getStats, parseVessels, splitCsvLine };
