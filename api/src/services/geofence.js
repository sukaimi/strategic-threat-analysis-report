'use strict';

const { haversineNm } = require('./anomaly');

// ---------------------------------------------------------------------------
// Singapore Approach Zone — 50 NM radius circle
// ---------------------------------------------------------------------------
const SG_APPROACH_CENTER = { lat: 1.30, lon: 103.82 };
const SG_APPROACH_RADIUS_NM = 50;

/**
 * Check if any flagged/sanctioned vessels have entered the Singapore approach zone.
 * Generates CRITICAL alerts for any matches.
 *
 * @param {Array<{mmsi: string, lat: number|null, lon: number|null, vessel_name: string|null, flagged: number}>} vessels
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{mmsi: string, vessel_name: string|null, distance_nm: number}>} vessels that triggered alerts
 */
function checkGeofence(vessels, db) {
  const triggered = [];

  for (const v of vessels) {
    // Only check flagged/sanctioned vessels
    if (!v.flagged) continue;
    if (v.lat == null || v.lon == null) continue;

    const dist = haversineNm(v.lat, v.lon, SG_APPROACH_CENTER.lat, SG_APPROACH_CENTER.lon);

    if (dist <= SG_APPROACH_RADIUS_NM) {
      const name = v.vessel_name || v.mmsi;
      const title = 'Sanctioned vessel entering approach zone';
      const description = `Sanctioned vessel ${name} (MMSI ${v.mmsi}) entering Singapore approach zone — ${dist.toFixed(1)} NM from center.`;

      // Dedup: check if a similar alert already exists in the last 30 minutes
      const existing = db.prepare(
        `SELECT id FROM alerts
         WHERE title = ? AND entity_mmsi = ?
           AND created_at >= datetime('now', '-30 minutes')
         LIMIT 1`
      ).get(title, v.mmsi);

      if (!existing) {
        db.prepare(
          'INSERT INTO alerts (severity, title, description, entity_mmsi) VALUES (?, ?, ?, ?)'
        ).run('CRITICAL', title, description, v.mmsi);
      }

      triggered.push({ mmsi: v.mmsi, vessel_name: v.vessel_name || null, distance_nm: dist });
    }
  }

  return triggered;
}

/**
 * Check if a single position is within the Singapore approach zone.
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
function isInApproachZone(lat, lon) {
  return haversineNm(lat, lon, SG_APPROACH_CENTER.lat, SG_APPROACH_CENTER.lon) <= SG_APPROACH_RADIUS_NM;
}

module.exports = {
  checkGeofence,
  isInApproachZone,
  SG_APPROACH_CENTER,
  SG_APPROACH_RADIUS_NM,
};
