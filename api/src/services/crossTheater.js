'use strict';

const { getDb } = require('../db');
const theaters = require('../theaters');

// Transit window: Singapore <-> Hormuz typically 7-10 days
// We check a broader 3-30 day window for correlation
const TRANSIT_WINDOW_DAYS_MIN = 3;
const TRANSIT_WINDOW_DAYS_MAX = 30;

/**
 * Find vessels that appear in BOTH theater databases (cross-theater transit detection).
 * A vessel seen in MERLION recently AND in DJINN (or vice versa) indicates a
 * Singapore <-> Hormuz transit — one of the most common routes for sanctioned oil delivery.
 *
 * @returns {Array<{mmsi: string, vessel_name: string, last_seen_merlion: string|null, last_seen_djinn: string|null, transit_direction: string}>}
 */
function findCrossTheaterVessels() {
  const theaterKeys = Object.keys(theaters);
  if (theaterKeys.length < 2) return [];

  // Collect latest sighting per MMSI from each theater
  const sightings = {};

  for (const key of theaterKeys) {
    let db;
    try {
      db = getDb(key);
    } catch (err) {
      console.warn('[cross-theater] Cannot open DB for %s: %s', key, err.message);
      continue;
    }

    try {
      const rows = db.prepare(
        `SELECT mmsi, vessel_name, MAX(recorded_at) AS last_seen
         FROM vessels
         WHERE recorded_at >= datetime('now', '-${TRANSIT_WINDOW_DAYS_MAX} days')
         GROUP BY mmsi`
      ).all();

      for (const row of rows) {
        if (!row.mmsi) continue;
        if (!sightings[row.mmsi]) sightings[row.mmsi] = {};
        sightings[row.mmsi][key] = {
          vessel_name: row.vessel_name,
          last_seen: row.last_seen,
        };
      }
    } catch (err) {
      console.warn('[cross-theater] Query failed for %s: %s', key, err.message);
    }
  }

  // Find MMSIs present in multiple theaters
  const results = [];

  for (const [mmsi, theaterData] of Object.entries(sightings)) {
    const presentIn = Object.keys(theaterData);
    if (presentIn.length < 2) continue;

    const merlionData = theaterData.merlion || null;
    const djinnData = theaterData.djinn || null;

    const lastSeenMerlion = merlionData?.last_seen || null;
    const lastSeenDjinn = djinnData?.last_seen || null;
    const vesselName = merlionData?.vessel_name || djinnData?.vessel_name || 'Unknown';

    // Determine transit direction based on which sighting is more recent
    let transitDirection = 'unknown';
    if (lastSeenMerlion && lastSeenDjinn) {
      const merlionTime = new Date(lastSeenMerlion).getTime();
      const djinnTime = new Date(lastSeenDjinn).getTime();
      const daysDiff = Math.abs(merlionTime - djinnTime) / (1000 * 60 * 60 * 24);

      if (daysDiff >= TRANSIT_WINDOW_DAYS_MIN) {
        transitDirection = merlionTime > djinnTime ? 'hormuz_to_singapore' : 'singapore_to_hormuz';
      } else {
        transitDirection = 'concurrent'; // seen in both very recently — unusual
      }
    }

    results.push({
      mmsi,
      vessel_name: vesselName,
      last_seen_merlion: lastSeenMerlion,
      last_seen_djinn: lastSeenDjinn,
      transit_direction: transitDirection,
      theaters_present: presentIn,
    });
  }

  return results;
}

/**
 * Check if a given MMSI exists in the other theater's DB.
 * Used by sanctions correlation to detect sanctioned vessels transiting between theaters.
 *
 * @param {string} mmsi
 * @param {string} currentTheater - The theater where the vessel was just detected
 * @returns {Array<{theater: string, last_seen: string, vessel_name: string}>}
 */
function findVesselInOtherTheaters(mmsi, currentTheater) {
  const results = [];
  const theaterKeys = Object.keys(theaters);

  for (const key of theaterKeys) {
    if (key === currentTheater) continue;

    let db;
    try {
      db = getDb(key);
    } catch (err) {
      continue;
    }

    try {
      const row = db.prepare(
        `SELECT mmsi, vessel_name, MAX(recorded_at) AS last_seen
         FROM vessels
         WHERE mmsi = ? AND recorded_at >= datetime('now', '-${TRANSIT_WINDOW_DAYS_MAX} days')
         GROUP BY mmsi`
      ).get(mmsi);

      if (row) {
        results.push({
          theater: key,
          last_seen: row.last_seen,
          vessel_name: row.vessel_name,
        });
      }
    } catch (err) {
      console.warn('[cross-theater] Lookup failed for %s in %s: %s', mmsi, key, err.message);
    }
  }

  return results;
}

/**
 * Cross-theater sanctions correlation.
 * When a sanctions match is detected, check if the same MMSI exists in other theaters.
 * If found, create CRITICAL alerts in BOTH theater DBs.
 *
 * @param {string} mmsi
 * @param {string} vesselName
 * @param {string} sourceTheater - Theater where the sanctions match was detected
 * @param {object} [events] - Optional event emitter for broadcasting alerts
 * @returns {Array<object>} Created alerts
 */
function crossTheaterSanctionsAlert(mmsi, vesselName, sourceTheater, events) {
  const otherSightings = findVesselInOtherTheaters(mmsi, sourceTheater);
  if (otherSightings.length === 0) return [];

  const createdAlerts = [];
  const name = vesselName || 'Unknown';

  for (const sighting of otherSightings) {
    const alertTitle = `Cross-theater sanctioned vessel transit detected`;
    const alertDescription = `Sanctioned vessel ${name} (MMSI: ${mmsi}) detected transiting between theaters. ` +
      `Source: ${sourceTheater.toUpperCase()} theater. Also seen in ${sighting.theater.toUpperCase()} theater ` +
      `(last seen: ${sighting.last_seen || 'unknown'}). Singapore-Hormuz transit is a primary route for sanctioned oil delivery.`;

    // Insert alert in BOTH theater DBs
    const theaterKeys = [sourceTheater, sighting.theater];

    for (const tKey of theaterKeys) {
      try {
        const db = getDb(tKey);

        // Dedup: check if we already have a similar alert in the last hour
        const existing = db.prepare(
          `SELECT id FROM alerts
           WHERE entity_mmsi = ? AND category = 'SANCTIONS'
             AND title LIKE '%cross-theater%'
             AND created_at >= datetime('now', '-1 hour')
           LIMIT 1`
        ).get(mmsi);

        if (existing) continue;

        const info = db.prepare(
          `INSERT INTO alerts (severity, title, description, entity_mmsi, category)
           VALUES ('CRITICAL', ?, ?, ?, 'SANCTIONS')`
        ).run(alertTitle, alertDescription, mmsi);

        const alert = {
          id: info.lastInsertRowid,
          severity: 'CRITICAL',
          title: alertTitle,
          description: alertDescription,
          entity_mmsi: mmsi,
          category: 'SANCTIONS',
          theater: tKey,
        };

        createdAlerts.push(alert);

        if (events) {
          events.emit('alert', alert);
        }
      } catch (err) {
        console.error('[cross-theater] Failed to create alert in %s: %s', tKey, err.message);
      }
    }
  }

  return createdAlerts;
}

/**
 * Periodic cross-theater correlation check.
 * Runs every 30 min from server.js.
 * Checks all cross-theater vessels against the sanctions list.
 *
 * @param {object} [events] - Optional event emitter
 * @returns {{transitVessels: Array, sanctionsAlerts: Array}}
 */
function runCrossTheaterCheck(events) {
  console.log('[cross-theater] Running periodic cross-theater correlation check');

  const transitVessels = findCrossTheaterVessels();
  const sanctionsAlerts = [];

  if (transitVessels.length > 0) {
    console.log('[cross-theater] Found %d vessels in multiple theaters', transitVessels.length);

    // Screen transit vessels against sanctions
    try {
      const sanctions = require('./sanctions');

      for (const vessel of transitVessels) {
        const result = sanctions.screenVessel({
          mmsi: vessel.mmsi,
          vessel_name: vessel.vessel_name,
        });

        if (result.matched) {
          console.log('[cross-theater] SANCTIONS MATCH: %s (%s) transiting between theaters', vessel.vessel_name, vessel.mmsi);

          // Determine which theater saw it most recently
          const sourceTheater = vessel.transit_direction === 'singapore_to_hormuz' ? 'djinn' :
            vessel.transit_direction === 'hormuz_to_singapore' ? 'merlion' : 'merlion';

          const alerts = crossTheaterSanctionsAlert(vessel.mmsi, vessel.vessel_name, sourceTheater, events);
          sanctionsAlerts.push(...alerts);
        }
      }
    } catch (err) {
      console.error('[cross-theater] Sanctions screening failed:', err.message);
    }
  } else {
    console.log('[cross-theater] No cross-theater vessels detected');
  }

  return { transitVessels, sanctionsAlerts };
}

/**
 * Get the unified STAR briefing: latest analysis from each theater + cross-theater data.
 *
 * @returns {object}
 */
function getUnifiedBriefing() {
  const theaterAnalyses = {};
  const theaterKeys = Object.keys(theaters);

  for (const key of theaterKeys) {
    try {
      const db = getDb(key);
      const row = db.prepare(
        'SELECT * FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1'
      ).get();

      if (row) {
        let analysis;
        try {
          analysis = JSON.parse(row.threat_json);
        } catch (_) {
          analysis = { raw: row.threat_json };
        }
        analysis.recorded_at = row.recorded_at;
        analysis.composite_score = row.composite_score;
        theaterAnalyses[key] = analysis;
      } else {
        theaterAnalyses[key] = null;
      }
    } catch (err) {
      console.warn('[cross-theater] Cannot read analysis for %s: %s', key, err.message);
      theaterAnalyses[key] = null;
    }
  }

  const transitVessels = findCrossTheaterVessels();

  // Find shared sanctions — vessels in multiple theaters that are sanctioned
  const sharedSanctions = [];
  try {
    const sanctions = require('./sanctions');
    for (const vessel of transitVessels) {
      const result = sanctions.screenVessel({
        mmsi: vessel.mmsi,
        vessel_name: vessel.vessel_name,
      });
      if (result.matched) {
        sharedSanctions.push({
          ...vessel,
          sanctions_hits: result.hits,
        });
      }
    }
  } catch (_) {}

  return {
    generated: new Date().toISOString(),
    theaters: theaterAnalyses,
    crossTheater: {
      transitVessels,
      sharedSanctions,
    },
  };
}

module.exports = {
  findCrossTheaterVessels,
  findVesselInOtherTheaters,
  crossTheaterSanctionsAlert,
  runCrossTheaterCheck,
  getUnifiedBriefing,
};
