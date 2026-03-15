'use strict';

const { getDb } = require('../db');
const theaters = require('../theaters');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Haversine distance threshold for AIS position jump (nautical miles)
const POSITION_JUMP_NM = 8;
const POSITION_JUMP_WINDOW_MIN = 5;

// Speed thresholds per vessel type (knots)
const SPEED_THRESHOLDS = {
  tanker: 18,
  bulk_carrier: 18,
  container: 25,
  passenger: 40,
  ferry: 40,
  fishing: 12,
  default: 30,
};

// AIS dark period thresholds
const DARK_ACTIVE_WINDOW_MIN = 180;  // vessel was active in last 3 hours (to catch 120 min dark)
const DARK_TIERS = [
  { minutesSilent: 120, severity: 'CRITICAL', label: 'CRITICAL dark period (2h+)' },
  { minutesSilent: 60,  severity: 'HIGH',     label: 'Prolonged dark period (1h+)' },
  { minutesSilent: 30,  severity: 'MEDIUM',   label: 'AIS dark period (30m+)' },
  // 10 min: internal tracking only, no alert
];
const DARK_INTERNAL_THRESHOLD_MIN = 10;

// Stationary in shipping lane threshold
const STATIONARY_SPEED_KT = 0.5;
const STATIONARY_MIN_READINGS = 2;

// Dedup window (minutes)
const DEDUP_WINDOW_MIN = 30;

// ---------------------------------------------------------------------------
// In-memory alert dedup cache  (Map<string, number>)
// Key = `${mmsi}:${alertType}`, Value = Date.now() timestamp
// ---------------------------------------------------------------------------
const recentAlerts = new Map();

/**
 * Prune entries older than `maxAgeMinutes` from the in-memory cache.
 * Called at the start of every detection cycle.
 */
function pruneRecentAlerts(maxAgeMinutes = 60) {
  const cutoff = Date.now() - maxAgeMinutes * 60000;
  for (const [key, ts] of recentAlerts) {
    if (ts < cutoff) recentAlerts.delete(key);
  }
}

/**
 * Returns true if this (mmsi, alertType) pair should fire an alert,
 * i.e. no alert for the same key exists within the last `windowMinutes`.
 * Records the current time in the cache when returning true.
 */
function shouldAlert(mmsi, alertType, windowMinutes = DEDUP_WINDOW_MIN) {
  const key = `${mmsi}:${alertType}`;
  const prev = recentAlerts.get(key);
  if (prev && Date.now() - prev < windowMinutes * 60000) {
    return false; // suppress duplicate
  }
  recentAlerts.set(key, Date.now());
  return true;
}

/**
 * Seed the in-memory dedup cache from recent DB alerts so that PM2 restarts
 * do not cause an alert flood.  Loads alerts from the last DEDUP_WINDOW_MIN
 * minutes and populates the cache with their timestamps.
 * @param {import('better-sqlite3').Database} db
 */
function seedDedupCache(db) {
  try {
    const rows = db.prepare(
      `SELECT entity_mmsi, title, created_at FROM alerts
       WHERE created_at >= datetime('now', ? || ' minutes')
         AND entity_mmsi IS NOT NULL`
    ).all(String(-DEDUP_WINDOW_MIN));

    let seeded = 0;
    for (const row of rows) {
      const key = `${row.entity_mmsi}:${row.title}`;
      const ts = new Date(row.created_at + 'Z').getTime();
      // Keep the most recent timestamp per key
      const existing = recentAlerts.get(key);
      if (!existing || ts > existing) {
        recentAlerts.set(key, ts);
        seeded++;
      }
    }
    if (seeded > 0) {
      console.log(`[Anomaly] Seeded dedup cache with ${seeded} entries from DB`);
    }
  } catch (err) {
    console.error('[Anomaly] Failed to seed dedup cache:', err.message);
  }
}

// Zone bounding boxes (lon_min, lon_max, lat_min, lat_max)
const ZONES = {
  anchorage: { lonMin: 103.72, lonMax: 103.82, latMin: 1.17, latMax: 1.22 },
  tss:       { lonMin: 103.45, lonMax: 104.40, latMin: 1.13, latMax: 1.26 },
};

// TSS lane definitions for wrong-way detection
// Eastbound lane: southern half of TSS
const TSS_EASTBOUND = { lonMin: 103.45, lonMax: 104.40, latMin: 1.13, latMax: 1.19 };
// Westbound lane: northern half of TSS
const TSS_WESTBOUND = { lonMin: 103.45, lonMax: 104.40, latMin: 1.20, latMax: 1.26 };

// Chokepoint zones
const CHOKEPOINTS = {
  philip_channel:      { lonMin: 103.8325, lonMax: 103.8445, latMin: 1.2180, latMax: 1.2268, threshold: 10, label: 'Philip Channel' },
  main_strait_narrows: { lonMin: 103.7500, lonMax: 103.8200, latMin: 1.1850, latMax: 1.2050, threshold: 15, label: 'Main Strait Narrows' },
  eastern_approach:    { lonMin: 104.2000, lonMax: 104.3500, latMin: 1.2200, latMax: 1.2600, threshold: 12, label: 'Eastern Approach (Horsburgh)' },
};

// CPA collision thresholds
const CPA_DISTANCE_NM = 0.5;
const CPA_TIME_MIN = 15;
const CPA_NEARBY_NM = 5;

// Position-on-land check (Singapore island approximation)
const SINGAPORE_LAND = { latMin: 1.22, latMax: 1.47, lonMin: 103.6, lonMax: 104.1 };

// Known port/berth areas where vessels legitimately report land positions.
// ~200m buffer (~0.0018 deg) applied to each zone boundary.
const BERTH_EXCLUSION_ZONES = [
  { label: 'PSA Tanjong Pagar/Keppel', latMin: 1.2582, latMax: 1.2718, lonMin: 103.8282, lonMax: 103.8518 },
  { label: 'PSA Pasir Panjang',        latMin: 1.2682, latMax: 1.2918, lonMin: 103.7482, lonMax: 103.8018 },
  { label: 'Jurong Port',              latMin: 1.2982, latMax: 1.3218, lonMin: 103.6982, lonMax: 103.7318 },
  { label: 'Sembawang/Woodlands',      latMin: 1.4382, latMax: 1.4618, lonMin: 103.7582, lonMax: 103.7818 },
  { label: 'Changi',                   latMin: 1.3282, latMax: 1.3618, lonMin: 103.9582, lonMax: 104.0018 },
];

// ---------------------------------------------------------------------------
// Haversine distance (returns nautical miles)
// ---------------------------------------------------------------------------

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nautical miles
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------------------------------------------------------------------------
// Zone helpers
// ---------------------------------------------------------------------------

function isInZone(lat, lon, zone) {
  return (
    lon >= zone.lonMin && lon <= zone.lonMax &&
    lat >= zone.latMin && lat <= zone.latMax
  );
}

function isInAnchorageOrTSS(lat, lon) {
  return isInZone(lat, lon, ZONES.anchorage) || isInZone(lat, lon, ZONES.tss);
}

function isInTSS(lat, lon) {
  return isInZone(lat, lon, ZONES.tss);
}

// ---------------------------------------------------------------------------
// Vessel type helpers
// ---------------------------------------------------------------------------

/**
 * Map a vessel_type string (from DB or AIS type code) to a speed threshold category.
 */
function getSpeedThreshold(vesselType) {
  if (!vesselType) return SPEED_THRESHOLDS.default;
  const vt = vesselType.toLowerCase();
  if (vt.includes('tanker') || vt.includes('oil')) return SPEED_THRESHOLDS.tanker;
  if (vt.includes('bulk')) return SPEED_THRESHOLDS.bulk_carrier;
  if (vt.includes('container') || vt.includes('cargo')) return SPEED_THRESHOLDS.container;
  if (vt.includes('passenger') || vt.includes('cruise')) return SPEED_THRESHOLDS.passenger;
  if (vt.includes('ferry')) return SPEED_THRESHOLDS.ferry;
  if (vt.includes('fishing') || vt.includes('trawl')) return SPEED_THRESHOLDS.fishing;
  return SPEED_THRESHOLDS.default;
}

// ---------------------------------------------------------------------------
// Dedup: check if a similar alert already exists recently
// ---------------------------------------------------------------------------

function alertExists(db, title, entityMmsi) {
  const row = db.prepare(
    `SELECT id FROM alerts
     WHERE title = ? AND entity_mmsi = ?
       AND created_at >= datetime('now', ? || ' minutes')
     LIMIT 1`
  ).get(title, entityMmsi, String(-DEDUP_WINDOW_MIN));
  return !!row;
}

// ---------------------------------------------------------------------------
// Insert alert with dedup guard
// ---------------------------------------------------------------------------

function insertAlert(db, { severity, title, description, entity_mmsi, category }) {
  // In-memory dedup: derive alert type from title for cache key
  if (entity_mmsi && !shouldAlert(entity_mmsi, title)) {
    return null; // duplicate suppressed by in-memory cache
  }
  if (alertExists(db, title, entity_mmsi)) {
    return null; // duplicate suppressed by DB check
  }
  // Check if the alerts table has a category column
  let sql;
  if (category) {
    try {
      sql = 'INSERT INTO alerts (severity, title, description, entity_mmsi, category) VALUES (?, ?, ?, ?, ?)';
      const info = db.prepare(sql).run(severity, title, description, entity_mmsi, category);
      return info.lastInsertRowid;
    } catch (_) {
      // category column might not exist yet — fall back
    }
  }
  sql = 'INSERT INTO alerts (severity, title, description, entity_mmsi) VALUES (?, ?, ?, ?)';
  const info = db.prepare(sql).run(severity, title, description, entity_mmsi);
  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Check 1: AIS position jumps
// ---------------------------------------------------------------------------

function checkPositionJumps(db) {
  const anomalies = [];

  // Get the two most recent positions per MMSI within the window using window functions
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT mmsi, lat, lon, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY recorded_at DESC) AS rn
      FROM vessels
      WHERE recorded_at >= datetime('now', '${-POSITION_JUMP_WINDOW_MIN} minutes')
        AND lat IS NOT NULL AND lon IS NOT NULL
    )
    SELECT a.mmsi,
           a.lat AS lat1, a.lon AS lon1, a.recorded_at AS ts1,
           b.lat AS lat2, b.lon AS lon2, b.recorded_at AS ts2
    FROM ranked a
    JOIN ranked b ON a.mmsi = b.mmsi AND a.rn = 2 AND b.rn = 1
  `).all();

  for (const r of rows) {
    const dist = haversineNm(r.lat1, r.lon1, r.lat2, r.lon2);
    if (dist > POSITION_JUMP_NM) {
      const title = 'AIS position jump detected';
      const description = `MMSI ${r.mmsi} jumped ${dist.toFixed(1)} NM between ${r.ts1} and ${r.ts2}. Possible AIS spoofing or transponder manipulation.`;
      const id = insertAlert(db, {
        severity: 'HIGH',
        title,
        description,
        entity_mmsi: r.mmsi,
        category: 'SECURITY',
      });
      anomalies.push({ type: 'position_jump', mmsi: r.mmsi, distance_nm: dist, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 2: Speed threshold violations (vessel-type aware)
// ---------------------------------------------------------------------------

function checkSpeedViolations(db) {
  const anomalies = [];

  // Latest reading per MMSI in last 5 minutes
  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.vessel_name, v.vessel_type
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.speed_kt IS NOT NULL AND v.lat IS NOT NULL AND v.lon IS NOT NULL
  `).all();

  for (const r of rows) {
    const threshold = getSpeedThreshold(r.vessel_type);
    if (r.speed_kt > threshold && isInAnchorageOrTSS(r.lat, r.lon)) {
      const zoneName = isInZone(r.lat, r.lon, ZONES.anchorage) ? 'anchorage zone' : 'TSS lane';
      const typeLabel = r.vessel_type ? ` [${r.vessel_type}]` : '';
      const title = 'Speed threshold violation';
      const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''}${typeLabel} reporting ${r.speed_kt.toFixed(1)} kt in ${zoneName} (limit: ${threshold} kt).`;
      const id = insertAlert(db, {
        severity: 'MEDIUM',
        title,
        description,
        entity_mmsi: r.mmsi,
        category: 'NAVIGATIONAL',
      });
      anomalies.push({ type: 'speed_violation', mmsi: r.mmsi, speed_kt: r.speed_kt, zone: zoneName, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 3: AIS dark period (tiered)
// ---------------------------------------------------------------------------

function checkAISDark(db) {
  const anomalies = [];

  // Vessels active in the last DARK_ACTIVE_WINDOW_MIN but not updated recently
  const rows = db.prepare(`
    SELECT mmsi, MAX(recorded_at) AS last_seen, vessel_name
    FROM vessels
    WHERE recorded_at >= datetime('now', '${-DARK_ACTIVE_WINDOW_MIN} minutes')
    GROUP BY mmsi
    HAVING MAX(recorded_at) < datetime('now', '${-DARK_INTERNAL_THRESHOLD_MIN} minutes')
  `).all();

  for (const r of rows) {
    // Calculate how many minutes since last seen
    const lastSeenTime = new Date(r.last_seen + 'Z').getTime();
    const nowMs = Date.now();
    const silentMin = (nowMs - lastSeenTime) / 60000;

    // Find the highest tier that applies
    let matched = null;
    for (const tier of DARK_TIERS) {
      if (silentMin >= tier.minutesSilent) {
        matched = tier;
        break; // DARK_TIERS is sorted descending by minutesSilent
      }
    }

    if (!matched) {
      // Under 30 min: internal tracking only, no alert
      anomalies.push({ type: 'ais_dark_internal', mmsi: r.mmsi, last_seen: r.last_seen, silent_min: Math.round(silentMin) });
      continue;
    }

    const title = matched.label;
    const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''} last seen at ${r.last_seen}. No position update in ${Math.round(silentMin)} minutes — possible transponder shutoff.`;
    const id = insertAlert(db, {
      severity: matched.severity,
      title,
      description,
      entity_mmsi: r.mmsi,
      category: 'SECURITY',
    });
    anomalies.push({ type: 'ais_dark', mmsi: r.mmsi, last_seen: r.last_seen, severity: matched.severity, silent_min: Math.round(silentMin), alert_id: id });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 4: Stationary in shipping lane (TSS)
// ---------------------------------------------------------------------------

function checkStationaryInLane(db) {
  const anomalies = [];

  // Get the 2 most recent readings per MMSI in the last 10 minutes
  const mmsiRows = db.prepare(`
    SELECT DISTINCT mmsi FROM vessels
    WHERE recorded_at >= datetime('now', '-10 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL
      AND speed_kt IS NOT NULL
  `).all();

  const stmtRecent = db.prepare(`
    SELECT lat, lon, speed_kt, recorded_at, vessel_name
    FROM vessels
    WHERE mmsi = ? AND recorded_at >= datetime('now', '-10 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL AND speed_kt IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT ?
  `);

  for (const { mmsi } of mmsiRows) {
    const readings = stmtRecent.all(mmsi, STATIONARY_MIN_READINGS);
    if (readings.length < STATIONARY_MIN_READINGS) continue;

    // All readings must be stationary and inside TSS
    const allStationary = readings.every(
      (r) => r.speed_kt < STATIONARY_SPEED_KT && isInTSS(r.lat, r.lon)
    );

    if (allStationary) {
      const title = 'Stationary vessel in TSS lane';
      const description = `MMSI ${mmsi}${readings[0].vessel_name ? ` (${readings[0].vessel_name})` : ''} stationary (<${STATIONARY_SPEED_KT} kt) in TSS lane for ${readings.length} consecutive readings. Potential obstruction or anchoring violation.`;
      const id = insertAlert(db, {
        severity: 'MEDIUM',
        title,
        description,
        entity_mmsi: mmsi,
        category: 'NAVIGATIONAL',
      });
      anomalies.push({ type: 'stationary_in_lane', mmsi, readings: readings.length, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 5: CPA collision risk (H1)
// ---------------------------------------------------------------------------

function checkCollisionRisk(db) {
  const anomalies = [];

  // Get latest position of all vessels with valid speed/heading in last 5 min
  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.heading, v.vessel_name
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.lat IS NOT NULL AND v.lon IS NOT NULL
      AND v.speed_kt IS NOT NULL AND v.speed_kt > 0
      AND v.heading IS NOT NULL AND v.heading < 360
  `).all();

  // Check all pairs within bounding-box pre-filter
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];

      // Quick bounding box pre-filter (~5NM ≈ 0.083 degrees)
      if (Math.abs(a.lat - b.lat) > 0.1 || Math.abs(a.lon - b.lon) > 0.1) continue;

      const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
      if (dist > CPA_NEARBY_NM) continue;

      // Calculate CPA using relative velocity
      const cpaResult = calculateCPA(a, b);
      if (cpaResult && cpaResult.cpa < CPA_DISTANCE_NM && cpaResult.tcpa > 0 && cpaResult.tcpa < CPA_TIME_MIN) {
        const title = 'Collision risk — close CPA';
        const description = `MMSI ${a.mmsi} and ${b.mmsi} — CPA ${cpaResult.cpa.toFixed(2)} NM in ${cpaResult.tcpa.toFixed(1)} min. Current distance: ${dist.toFixed(2)} NM.`;
        const id = insertAlert(db, {
          severity: 'HIGH',
          title,
          description,
          entity_mmsi: a.mmsi,
          category: 'SAFETY',
        });
        anomalies.push({ type: 'collision_risk', mmsi_a: a.mmsi, mmsi_b: b.mmsi, cpa_nm: cpaResult.cpa, tcpa_min: cpaResult.tcpa, alert_id: id });
      }
    }
  }

  return anomalies;
}

/**
 * Calculate CPA (Closest Point of Approach) and TCPA between two vessels.
 * Uses linear relative motion model.
 * @returns {{ cpa: number, tcpa: number }|null} cpa in NM, tcpa in minutes
 */
function calculateCPA(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;

  // Convert speed (knots) and heading to velocity components (NM/min)
  const vax = (a.speed_kt / 60) * Math.sin(toRad(a.heading));
  const vay = (a.speed_kt / 60) * Math.cos(toRad(a.heading));
  const vbx = (b.speed_kt / 60) * Math.sin(toRad(b.heading));
  const vby = (b.speed_kt / 60) * Math.cos(toRad(b.heading));

  // Relative velocity
  const dvx = vax - vbx;
  const dvy = vay - vby;

  // Relative position (approximate: convert lat/lon diff to NM)
  const dpx = (a.lon - b.lon) * 60 * Math.cos(toRad((a.lat + b.lat) / 2));
  const dpy = (a.lat - b.lat) * 60;

  const dvSq = dvx * dvx + dvy * dvy;
  if (dvSq < 1e-10) return null; // vessels moving parallel or both stationary

  // TCPA (time to CPA in minutes)
  const tcpa = -(dpx * dvx + dpy * dvy) / dvSq;

  // CPA distance at TCPA
  const cpx = dpx + dvx * tcpa;
  const cpy = dpy + dvy * tcpa;
  const cpa = Math.sqrt(cpx * cpx + cpy * cpy);

  return { cpa, tcpa };
}

// ---------------------------------------------------------------------------
// Check 6: Wrong-way TSS traffic (H2)
// ---------------------------------------------------------------------------

function checkWrongWayTSS(db) {
  const anomalies = [];

  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.heading, v.vessel_name
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.lat IS NOT NULL AND v.lon IS NOT NULL
      AND v.heading IS NOT NULL AND v.heading < 360
      AND v.speed_kt IS NOT NULL AND v.speed_kt > 1
  `).all();

  for (const r of rows) {
    let wrongWay = false;
    let laneDesc = '';

    // Eastbound lane: heading should be roughly 45-135
    if (isInZone(r.lat, r.lon, TSS_EASTBOUND)) {
      if (r.heading < 45 || r.heading > 135) {
        wrongWay = true;
        laneDesc = 'eastbound';
      }
    }

    // Westbound lane: heading should be roughly 225-315
    if (isInZone(r.lat, r.lon, TSS_WESTBOUND)) {
      if (r.heading < 225 || r.heading > 315) {
        wrongWay = true;
        laneDesc = 'westbound';
      }
    }

    if (wrongWay) {
      const title = 'Wrong-way traffic in TSS';
      const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''} heading ${r.heading.toFixed(0)} deg in ${laneDesc} lane at ${r.speed_kt.toFixed(1)} kt. Vessel may be contravening COLREGS Rule 10.`;
      const id = insertAlert(db, {
        severity: 'MEDIUM',
        title,
        description,
        entity_mmsi: r.mmsi,
        category: 'NAVIGATIONAL',
      });
      anomalies.push({ type: 'wrong_way_tss', mmsi: r.mmsi, heading: r.heading, lane: laneDesc, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 7: MMSI duplication detection (H7)
// ---------------------------------------------------------------------------

function checkMMSIDuplication(db) {
  const anomalies = [];

  // Group latest positions by MMSI in last 5 min, find those with multiple distant positions
  const rows = db.prepare(`
    SELECT mmsi, lat, lon, recorded_at, vessel_name
    FROM vessels
    WHERE recorded_at >= datetime('now', '-5 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY mmsi, recorded_at DESC
  `).all();

  // Group by MMSI
  const byMmsi = new Map();
  for (const r of rows) {
    if (!byMmsi.has(r.mmsi)) byMmsi.set(r.mmsi, []);
    byMmsi.get(r.mmsi).push(r);
  }

  for (const [mmsi, positions] of byMmsi) {
    if (positions.length < 2) continue;

    // Check if any two simultaneous positions are >5NM apart
    // "Simultaneous" = within 1 minute of each other
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];

        // Check time closeness (within 2 minutes)
        const ta = new Date(a.recorded_at + 'Z').getTime();
        const tb = new Date(b.recorded_at + 'Z').getTime();
        if (Math.abs(ta - tb) > 120000) continue; // > 2 min apart

        const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
        if (dist > 5) {
          const title = 'MMSI duplication suspected';
          const description = `MMSI ${mmsi} detected at two positions ${dist.toFixed(1)} NM apart within 2 minutes. Possible MMSI spoofing or cloning.`;
          const id = insertAlert(db, {
            severity: 'HIGH',
            title,
            description,
            entity_mmsi: mmsi,
            category: 'SECURITY',
          });
          anomalies.push({ type: 'mmsi_duplication', mmsi, distance_nm: dist, alert_id: id });
          break; // one alert per MMSI is enough
        }
      }
      if (anomalies.some(a => a.type === 'mmsi_duplication' && a.mmsi === mmsi)) break;
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 8: OSINT-sensor auto-correlation (H8)
// ---------------------------------------------------------------------------

function checkOSINTCorrelation(db) {
  const anomalies = [];

  // Get high-relevance OSINT articles from last 24h that mention MMSIs or vessel names
  let articles;
  try {
    articles = db.prepare(`
      SELECT id, title, entities_json, relevance_score
      FROM intel_articles
      WHERE relevance_score >= 40
        AND created_at >= datetime('now', '-24 hours')
    `).all();
  } catch (_) {
    return anomalies; // intel_articles table may not exist
  }

  if (!articles || articles.length === 0) return anomalies;

  // Get currently tracked vessels (last 5 min)
  const vessels = db.prepare(`
    SELECT DISTINCT mmsi, vessel_name
    FROM vessels
    WHERE recorded_at >= datetime('now', '-5 minutes')
      AND mmsi IS NOT NULL
  `).all();

  const vesselMmsis = new Set(vessels.map(v => v.mmsi));
  const vesselNameMap = new Map();
  for (const v of vessels) {
    if (v.vessel_name) {
      vesselNameMap.set(v.vessel_name.toUpperCase().trim(), v.mmsi);
    }
  }

  for (const article of articles) {
    let entities;
    try {
      entities = JSON.parse(article.entities_json);
    } catch (_) {
      continue;
    }
    if (!entities) continue;

    // Check MMSIs
    const matchedMmsis = (entities.mmsis || []).filter(m => vesselMmsis.has(m));

    // Check vessel names
    for (const name of (entities.vesselNames || [])) {
      const upperName = name.toUpperCase().trim();
      const mmsi = vesselNameMap.get(upperName);
      if (mmsi && !matchedMmsis.includes(mmsi)) {
        matchedMmsis.push(mmsi);
      }
    }

    for (const mmsi of matchedMmsis) {
      const title = 'OSINT correlation — tracked vessel in intelligence report';
      const description = `MMSI ${mmsi} mentioned in OSINT article: "${article.title}" (relevance: ${article.relevance_score}).`;
      const id = insertAlert(db, {
        severity: 'MEDIUM',
        title,
        description,
        entity_mmsi: mmsi,
        category: 'SECURITY',
      });
      if (id) {
        anomalies.push({ type: 'osint_correlation', mmsi, article_id: article.id, alert_id: id });
      }
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 9: Additional AIS spoofing patterns (M10)
// ---------------------------------------------------------------------------

function checkAISSpoofingPatterns(db) {
  const anomalies = [];

  // Get latest two positions per MMSI
  const mmsiRows = db.prepare(`
    SELECT DISTINCT mmsi FROM vessels
    WHERE recorded_at >= datetime('now', '-5 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL
  `).all();

  const stmtRecent = db.prepare(`
    SELECT lat, lon, speed_kt, heading, recorded_at, vessel_name
    FROM vessels
    WHERE mmsi = ? AND recorded_at >= datetime('now', '-10 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT 2
  `);

  for (const { mmsi } of mmsiRows) {
    const readings = stmtRecent.all(mmsi);

    // -- Position-on-land detection --
    // Suppressed entirely for known berth/port zones (GPS drift from berthed vessels).
    // Downgraded to MEDIUM for other on-land positions (rarely true spoofing).
    if (readings.length >= 1) {
      const r = readings[0];
      if (r.lat > SINGAPORE_LAND.latMin && r.lat < SINGAPORE_LAND.latMax &&
          r.lon > SINGAPORE_LAND.lonMin && r.lon < SINGAPORE_LAND.lonMax) {
        // Check if position falls within a known berth exclusion zone
        const inBerthZone = BERTH_EXCLUSION_ZONES.some(
          (z) => r.lat >= z.latMin && r.lat <= z.latMax && r.lon >= z.lonMin && r.lon <= z.lonMax
        );

        if (!inBerthZone) {
          // On land but NOT near a known berth — likely GPS error, flag at MEDIUM
          const title = 'Position-on-land detected';
          const description = `MMSI ${mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''} reporting position on land (${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}). Possible GPS error or transponder fault.`;
          const id = insertAlert(db, {
            severity: 'MEDIUM',
            title,
            description,
            entity_mmsi: mmsi,
            category: 'SECURITY',
          });
          if (id) anomalies.push({ type: 'position_on_land', mmsi, lat: r.lat, lon: r.lon, alert_id: id });
        }
        // else: in berth zone — suppress alert entirely (GPS drift from berthed vessel)
      }
    }

    // -- Speed/heading inconsistency --
    if (readings.length >= 2) {
      const curr = readings[0];
      const prev = readings[1];
      const dist = haversineNm(prev.lat, prev.lon, curr.lat, curr.lon);

      // Reporting 0 speed but position changed significantly (>0.5 NM)
      if (curr.speed_kt !== null && curr.speed_kt < 0.5 && dist > 0.5) {
        const title = 'Speed/position inconsistency';
        const description = `MMSI ${mmsi} reporting ${(curr.speed_kt || 0).toFixed(1)} kt but moved ${dist.toFixed(2)} NM. Possible AIS data manipulation.`;
        const id = insertAlert(db, {
          severity: 'MEDIUM',
          title,
          description,
          entity_mmsi: mmsi,
          category: 'SECURITY',
        });
        if (id) anomalies.push({ type: 'speed_position_mismatch', mmsi, reported_speed: curr.speed_kt, actual_distance: dist, alert_id: id });
      }

      // High speed reported but position unchanged (< 0.01 NM)
      if (curr.speed_kt !== null && curr.speed_kt > 5 && dist < 0.01) {
        const title = 'Speed/position inconsistency';
        const description = `MMSI ${mmsi} reporting ${curr.speed_kt.toFixed(1)} kt but position unchanged. Possible AIS data manipulation.`;
        const id = insertAlert(db, {
          severity: 'MEDIUM',
          title,
          description,
          entity_mmsi: mmsi,
          category: 'SECURITY',
        });
        if (id) anomalies.push({ type: 'speed_position_mismatch', mmsi, reported_speed: curr.speed_kt, actual_distance: dist, alert_id: id });
      }
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 10: Chokepoint congestion (M4)
// ---------------------------------------------------------------------------

function checkChokepointCongestion(db) {
  const anomalies = [];
  for (const [key, cp] of Object.entries(CHOKEPOINTS)) {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
        AND lat IS NOT NULL AND lon IS NOT NULL
        AND lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?
    `).get(cp.latMin, cp.latMax, cp.lonMin, cp.lonMax);
    const count = row ? row.cnt : 0;
    if (count > cp.threshold) {
      const title = 'Chokepoint congestion';
      const description = `${cp.label}: ${count} vessels detected (threshold: ${cp.threshold}). Elevated collision or blockage risk.`;
      const id = insertAlert(db, { severity: 'MEDIUM', title, description, entity_mmsi: null, category: 'NAVIGATIONAL' });
      anomalies.push({ type: 'chokepoint_congestion', zone: key, vessel_count: count, alert_id: id });
    }
  }
  return anomalies;
}

// ---------------------------------------------------------------------------
// Check 11: Pattern-of-life deviation (M7)
// ---------------------------------------------------------------------------

function checkPatternDeviations(db) {
  const anomalies = [];
  let patterns;
  try { patterns = require('./patterns'); } catch (_) { return anomalies; }

  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.heading, v.vessel_name
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes') GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.lat IS NOT NULL AND v.lon IS NOT NULL
  `).all();

  for (const r of rows) {
    try {
      const result = patterns.checkDeviation(db, r.mmsi, { lat: r.lat, lon: r.lon, speed_kt: r.speed_kt });
      if (result && result.deviations.length > 0) {
        const title = 'Pattern-of-life deviation';
        const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''}: ${result.deviations.join('; ')}`;
        const id = insertAlert(db, { severity: 'MEDIUM', title, description, entity_mmsi: r.mmsi, category: 'SECURITY' });
        anomalies.push({ type: 'pattern_deviation', mmsi: r.mmsi, deviations: result.deviations, alert_id: id });
      }
    } catch (_) {}
  }
  return anomalies;
}

// ---------------------------------------------------------------------------
// DJINN-specific zone definitions
// ---------------------------------------------------------------------------

const DJINN_ZONES = {
  anchorage_fujairah:   { lonMin: 56.25, lonMax: 56.55, latMin: 25.00, latMax: 25.30 },
  anchorage_khorfakkan: { lonMin: 56.35, lonMax: 56.45, latMin: 25.30, latMax: 25.40 },
  tss_inbound:   { lonMin: 56.0, lonMax: 56.6, latMin: 26.20, latMax: 26.65 },
  tss_outbound:  { lonMin: 56.0, lonMax: 56.6, latMin: 26.00, latMax: 26.18 },
  tss_separation:{ lonMin: 56.0, lonMax: 56.6, latMin: 26.18, latMax: 26.20 },
  hormuz_narrows:{ lonMin: 56.05, lonMax: 56.45, latMin: 26.30, latMax: 26.60 },
};

const DJINN_CHOKEPOINTS = {
  hormuz_narrows:    { lonMin: 56.05, lonMax: 56.45, latMin: 26.30, latMax: 26.60, threshold: 20, label: 'Hormuz Narrows' },
  musandam_approach: { lonMin: 56.20, lonMax: 56.50, latMin: 26.00, latMax: 26.25, threshold: 15, label: 'Musandam Approach' },
  fujairah_approach: { lonMin: 56.30, lonMax: 56.60, latMin: 25.20, latMax: 25.50, threshold: 12, label: 'Fujairah Approach' },
};

const HORMUZ_TSS_INBOUND_HEADING  = { min: 290, max: 350 };
const HORMUZ_TSS_OUTBOUND_HEADING = { min: 110, max: 170 };

// STS transfer detection constants
const STS_PROXIMITY_NM = 0.5;
const STS_MAX_SPEED_KT = 2;

// IRGCN swarm detection constants
const SWARM_SPEED_THRESHOLD_KT = 25;
const SWARM_PROXIMITY_NM = 2;
const SWARM_MIN_VESSELS = 3;

// Fujairah loitering threshold (hours)
const LOITERING_THRESHOLD_HOURS = 72;

// In-memory dwell time tracker for Fujairah loitering  { mmsi -> { firstSeen: Date, lastSeen: Date } }
const _fujairahDwell = new Map();

// ---------------------------------------------------------------------------
// DJINN Check D1: STS Transfer Detection
// ---------------------------------------------------------------------------

function checkSTSTransfer(db) {
  const anomalies = [];

  // Get all vessels in DJINN AOR with speed < 2 kt in last 10 minutes
  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.vessel_name, v.vessel_type
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-10 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.speed_kt IS NOT NULL AND v.speed_kt < ?
      AND v.lat IS NOT NULL AND v.lon IS NOT NULL
  `).all(STS_MAX_SPEED_KT);

  // Check all pairs for proximity
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];

      // Quick lat/lon pre-filter (~0.5 NM ~ 0.008 deg)
      if (Math.abs(a.lat - b.lat) > 0.02 || Math.abs(a.lon - b.lon) > 0.02) continue;

      const dist = haversineNm(a.lat, a.lon, b.lat, b.lon);
      if (dist > STS_PROXIMITY_NM) continue;

      // STS pattern detected — determine severity
      const aIsTanker = isTankerType(a.vessel_type);
      const bIsTanker = isTankerType(b.vessel_type);
      const inAnchorage = isInZone(a.lat, a.lon, DJINN_ZONES.anchorage_fujairah) ||
                          isInZone(a.lat, a.lon, DJINN_ZONES.anchorage_khorfakkan);

      let severity;
      if (aIsTanker && bIsTanker && !inAnchorage) {
        severity = 'CRITICAL';
      } else if (!inAnchorage) {
        severity = 'HIGH';
      } else if (aIsTanker && bIsTanker) {
        severity = 'MEDIUM';
      } else {
        severity = 'MEDIUM';
      }

      const title = 'STS transfer pattern detected';
      const description = `MMSI ${a.mmsi}${a.vessel_name ? ` (${a.vessel_name})` : ''} and MMSI ${b.mmsi}${b.vessel_name ? ` (${b.vessel_name})` : ''} stationary within ${dist.toFixed(2)} NM. Both < ${STS_MAX_SPEED_KT} kt.${inAnchorage ? ' (In anchorage zone)' : ' (Outside anchorage — elevated concern)'}`;
      const id = insertAlert(db, {
        severity,
        title,
        description,
        entity_mmsi: a.mmsi,
        category: 'SANCTIONS',
      });
      anomalies.push({ type: 'sts_transfer', mmsi_a: a.mmsi, mmsi_b: b.mmsi, distance_nm: dist, severity, alert_id: id });
    }
  }

  return anomalies;
}

function isTankerType(vesselType) {
  if (!vesselType) return false;
  const vt = vesselType.toLowerCase();
  return vt.includes('tanker') || vt.includes('oil') || vt.includes('chemical') || vt.includes('lpg') || vt.includes('lng');
}

// ---------------------------------------------------------------------------
// DJINN Check D2: IRGCN Fast-Boat Swarm Detection
// ---------------------------------------------------------------------------

function checkFastBoatSwarm(db) {
  const anomalies = [];

  // Get all fast vessels (>25 kt) in last 5 minutes
  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.heading, v.vessel_name, v.vessel_type
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.speed_kt IS NOT NULL AND v.speed_kt > ?
      AND v.lat IS NOT NULL AND v.lon IS NOT NULL
  `).all(SWARM_SPEED_THRESHOLD_KT);

  if (rows.length < SWARM_MIN_VESSELS) return anomalies;

  // Simple clustering: check if 3+ fast vessels are within SWARM_PROXIMITY_NM of each other
  // Use a greedy approach: for each vessel, count how many others are within range
  const clustered = new Set();

  for (let i = 0; i < rows.length; i++) {
    if (clustered.has(rows[i].mmsi)) continue;

    const cluster = [rows[i]];
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      const dist = haversineNm(rows[i].lat, rows[i].lon, rows[j].lat, rows[j].lon);
      if (dist <= SWARM_PROXIMITY_NM) {
        cluster.push(rows[j]);
      }
    }

    if (cluster.length >= SWARM_MIN_VESSELS) {
      // Mark all as clustered to avoid duplicate swarm alerts
      for (const v of cluster) clustered.add(v.mmsi);

      const severity = cluster.length >= 5 ? 'CRITICAL' : 'HIGH';
      const mmsis = cluster.map(v => v.mmsi).join(', ');
      const title = 'IRGCN fast-boat swarm pattern';
      const description = `${cluster.length} fast vessels (>${SWARM_SPEED_THRESHOLD_KT} kt) detected within ${SWARM_PROXIMITY_NM} NM: ${mmsis}. Possible coordinated swarm activity.`;
      const id = insertAlert(db, {
        severity,
        title,
        description,
        entity_mmsi: cluster[0].mmsi,
        category: 'SECURITY',
      });
      anomalies.push({ type: 'fast_boat_swarm', vessel_count: cluster.length, mmsis: cluster.map(v => v.mmsi), severity, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// DJINN Check D3: Fujairah Anchorage Extended Loitering
// ---------------------------------------------------------------------------

function checkFujairahLoitering(db) {
  const anomalies = [];

  // Get vessels currently stationary at Fujairah anchorage
  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.vessel_name, v.vessel_type
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-10 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.speed_kt IS NOT NULL AND v.speed_kt < 1
      AND v.lat IS NOT NULL AND v.lon IS NOT NULL
  `).all();

  const now = Date.now();

  // Track vessels currently in Fujairah anchorage
  const currentMmsis = new Set();

  for (const r of rows) {
    if (!isInZone(r.lat, r.lon, DJINN_ZONES.anchorage_fujairah)) continue;

    currentMmsis.add(r.mmsi);

    if (!_fujairahDwell.has(r.mmsi)) {
      _fujairahDwell.set(r.mmsi, { firstSeen: now, lastSeen: now });
    } else {
      _fujairahDwell.get(r.mmsi).lastSeen = now;
    }

    const dwell = _fujairahDwell.get(r.mmsi);
    const hoursInZone = (now - dwell.firstSeen) / (3600 * 1000);

    let severity = null;
    if (hoursInZone >= 336) {        // 14 days
      severity = 'CRITICAL';
    } else if (hoursInZone >= 168) {  // 7 days
      severity = 'HIGH';
    } else if (hoursInZone >= LOITERING_THRESHOLD_HOURS) { // 72 hours (3 days)
      severity = 'MEDIUM';
    }

    if (severity) {
      const title = 'Extended loitering at Fujairah anchorage';
      const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''} has been stationary at Fujairah anchorage for ${hoursInZone.toFixed(0)} hours. Possible sanctions evasion indicator.`;
      const id = insertAlert(db, {
        severity,
        title,
        description,
        entity_mmsi: r.mmsi,
        category: 'SANCTIONS',
      });
      anomalies.push({ type: 'fujairah_loitering', mmsi: r.mmsi, hours: hoursInZone, severity, alert_id: id });
    }
  }

  // Prune vessels that have left Fujairah
  for (const [mmsi] of _fujairahDwell) {
    if (!currentMmsis.has(mmsi)) {
      _fujairahDwell.delete(mmsi);
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// DJINN-specific: checkChokepointCongestionDjinn, checkWrongWayTSSDjinn
// ---------------------------------------------------------------------------

function checkChokepointCongestionDjinn(db) {
  const anomalies = [];
  for (const [key, cp] of Object.entries(DJINN_CHOKEPOINTS)) {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
        AND lat IS NOT NULL AND lon IS NOT NULL
        AND lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?
    `).get(cp.latMin, cp.latMax, cp.lonMin, cp.lonMax);
    const count = row ? row.cnt : 0;
    if (count > cp.threshold) {
      const title = 'Chokepoint congestion';
      const description = `${cp.label}: ${count} vessels detected (threshold: ${cp.threshold}). Elevated collision or blockage risk.`;
      const id = insertAlert(db, { severity: 'MEDIUM', title, description, entity_mmsi: null, category: 'NAVIGATIONAL' });
      anomalies.push({ type: 'chokepoint_congestion', zone: key, vessel_count: count, alert_id: id });
    }
  }
  return anomalies;
}

function checkWrongWayTSSDjinn(db) {
  const anomalies = [];

  const rows = db.prepare(`
    SELECT v.mmsi, v.lat, v.lon, v.speed_kt, v.heading, v.vessel_name
    FROM vessels v
    INNER JOIN (
      SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
      WHERE recorded_at >= datetime('now', '-5 minutes')
      GROUP BY mmsi
    ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
    WHERE v.lat IS NOT NULL AND v.lon IS NOT NULL
      AND v.heading IS NOT NULL AND v.heading < 360
      AND v.speed_kt IS NOT NULL AND v.speed_kt > 1
  `).all();

  for (const r of rows) {
    let wrongWay = false;
    let laneDesc = '';

    // Inbound lane (NW-bound into Gulf): heading should be 290-350
    if (isInZone(r.lat, r.lon, DJINN_ZONES.tss_inbound)) {
      // Handle wrapping: heading 290-350 means NOT in [0,290) and NOT in (350,360)
      const h = r.heading;
      if (h < HORMUZ_TSS_INBOUND_HEADING.min || h > HORMUZ_TSS_INBOUND_HEADING.max) {
        wrongWay = true;
        laneDesc = 'inbound (NW-bound)';
      }
    }

    // Outbound lane (SE-bound out of Gulf): heading should be 110-170
    if (isInZone(r.lat, r.lon, DJINN_ZONES.tss_outbound)) {
      if (r.heading < HORMUZ_TSS_OUTBOUND_HEADING.min || r.heading > HORMUZ_TSS_OUTBOUND_HEADING.max) {
        wrongWay = true;
        laneDesc = 'outbound (SE-bound)';
      }
    }

    if (wrongWay) {
      const severity = r.speed_kt > 5 ? 'HIGH' : 'MEDIUM';
      const title = 'Wrong-way traffic in Hormuz TSS';
      const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''} heading ${r.heading.toFixed(0)} deg in ${laneDesc} lane at ${r.speed_kt.toFixed(1)} kt. Vessel contravening Hormuz TSS routing.`;
      const id = insertAlert(db, {
        severity,
        title,
        description,
        entity_mmsi: r.mmsi,
        category: 'NAVIGATIONAL',
      });
      anomalies.push({ type: 'wrong_way_tss_hormuz', mmsi: r.mmsi, heading: r.heading, lane: laneDesc, severity, alert_id: id });
    }
  }

  return anomalies;
}

// Stationary in Hormuz TSS lane (uses DJINN zones)
function checkStationaryInLaneDjinn(db) {
  const anomalies = [];

  const mmsiRows = db.prepare(`
    SELECT DISTINCT mmsi FROM vessels
    WHERE recorded_at >= datetime('now', '-10 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL
      AND speed_kt IS NOT NULL
  `).all();

  const stmtRecent = db.prepare(`
    SELECT lat, lon, speed_kt, recorded_at, vessel_name
    FROM vessels
    WHERE mmsi = ? AND recorded_at >= datetime('now', '-10 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL AND speed_kt IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT ?
  `);

  for (const { mmsi } of mmsiRows) {
    const readings = stmtRecent.all(mmsi, STATIONARY_MIN_READINGS);
    if (readings.length < STATIONARY_MIN_READINGS) continue;

    const inHormuzTSS = (lat, lon) =>
      isInZone(lat, lon, DJINN_ZONES.tss_inbound) ||
      isInZone(lat, lon, DJINN_ZONES.tss_outbound);

    const allStationary = readings.every(
      (r) => r.speed_kt < STATIONARY_SPEED_KT && inHormuzTSS(r.lat, r.lon)
    );

    if (allStationary) {
      const title = 'Stationary vessel in Hormuz TSS lane';
      const description = `MMSI ${mmsi}${readings[0].vessel_name ? ` (${readings[0].vessel_name})` : ''} stationary (<${STATIONARY_SPEED_KT} kt) in Hormuz TSS for ${readings.length} consecutive readings. Potential obstruction — energy flow risk.`;
      const id = insertAlert(db, {
        severity: 'HIGH',
        title,
        description,
        entity_mmsi: mmsi,
        category: 'NAVIGATIONAL',
      });
      anomalies.push({ type: 'stationary_in_lane_hormuz', mmsi, readings: readings.length, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// DJINN Check D7: Dark Vessel Appearance Detection
// Detects vessels that materialize mid-strait without prior AIS history
// (sanctions evasion indicator — AIS turned back on mid-transit)
// ---------------------------------------------------------------------------

function checkDarkVesselAppearance(db) {
  const anomalies = [];

  // Find vessels whose first appearance in the DB is within the last 10 minutes
  const rows = db.prepare(`
    SELECT mmsi, MIN(recorded_at) AS first_seen, lat, lon, vessel_name, vessel_type
    FROM vessels
    GROUP BY mmsi
    HAVING first_seen >= datetime('now', '-10 minutes')
      AND lat IS NOT NULL AND lon IS NOT NULL
  `).all();

  for (const r of rows) {
    // Exclude positions near Bandar Abbas port area
    if (isInZone(r.lat, r.lon, { lonMin: 56.15, lonMax: 56.45, latMin: 27.05, latMax: 27.30 })) continue;
    // Exclude Fujairah anchorage
    if (isInZone(r.lat, r.lon, DJINN_ZONES.anchorage_fujairah)) continue;
    // Exclude Khorfakkan anchorage
    if (isInZone(r.lat, r.lon, DJINN_ZONES.anchorage_khorfakkan)) continue;

    // Must be within the Hormuz strait / narrows area (not in open sea far from TSS)
    const inTSS = isInZone(r.lat, r.lon, DJINN_ZONES.tss_inbound) ||
                  isInZone(r.lat, r.lon, DJINN_ZONES.tss_outbound) ||
                  isInZone(r.lat, r.lon, DJINN_ZONES.hormuz_narrows);
    if (!inTSS) continue;

    const title = 'AIS signal reappearance detected';
    const description = `MMSI ${r.mmsi}${r.vessel_name ? ` (${r.vessel_name})` : ''} first appeared mid-strait at [${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}] at ${r.first_seen}. No prior AIS history — possible AIS re-activation after dark period.`;
    const id = insertAlert(db, {
      severity: 'MEDIUM',
      title,
      description,
      entity_mmsi: r.mmsi,
      category: 'SECURITY',
    });
    if (id) {
      anomalies.push({ type: 'dark_vessel_appearance', mmsi: r.mmsi, first_seen: r.first_seen, lat: r.lat, lon: r.lon, alert_id: id });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Common checks that run against any theater DB
const COMMON_CHECKS = [
  checkPositionJumps,
  checkSpeedViolations,
  checkAISDark,
  checkCollisionRisk,
  checkMMSIDuplication,
  checkOSINTCorrelation,
  checkAISSpoofingPatterns,
  checkPatternDeviations,
];

// MERLION-specific checks (use Singapore zones)
const MERLION_CHECKS = [
  checkStationaryInLane,
  checkWrongWayTSS,
  checkChokepointCongestion,
];

// DJINN-specific checks (use Hormuz zones)
const DJINN_CHECKS = [
  checkStationaryInLaneDjinn,
  checkWrongWayTSSDjinn,
  checkChokepointCongestionDjinn,
  checkSTSTransfer,
  checkFastBoatSwarm,
  checkFujairahLoitering,
  checkDarkVesselAppearance,
];

/**
 * Run all deterministic anomaly checks against the database.
 * Inserts alerts for detected anomalies (with dedup) and returns a summary array.
 * @param {import('better-sqlite3').Database} [db] - optional DB handle
 * @param {string} [theaterKey] - 'merlion' or 'djinn'; defaults to 'merlion'
 * @returns {Array<Object>} detected anomalies
 */
function runAnomalyChecks(db, theaterKey) {
  if (!db) db = getDb();
  if (!theaterKey) theaterKey = 'merlion';

  // Prune stale entries from in-memory dedup cache each cycle
  pruneRecentAlerts(60);

  const anomalies = [];
  const theaterChecks = theaterKey === 'djinn' ? DJINN_CHECKS : MERLION_CHECKS;
  const checks = [...COMMON_CHECKS, ...theaterChecks];

  for (const check of checks) {
    try {
      anomalies.push(...check(db));
    } catch (err) {
      console.error(`[anomaly:${theaterKey}] ${check.name} failed: ${err.message}`);
    }
  }

  return anomalies;
}

/**
 * Run anomaly checks for ALL configured theaters.
 * Returns a map of theater key -> anomalies array.
 * @returns {Object<string, Array<Object>>}
 */
function runAllTheaterAnomalyChecks() {
  const results = {};
  for (const key of Object.keys(theaters)) {
    try {
      const db = getDb(key);
      results[key] = runAnomalyChecks(db, key);
    } catch (err) {
      console.error(`[anomaly] Theater ${key} cycle failed: ${err.message}`);
      results[key] = [];
    }
  }
  return results;
}

module.exports = {
  runAnomalyChecks,
  runAllTheaterAnomalyChecks,
  // Exported for testing
  haversineNm,
  isInZone,
  isInAnchorageOrTSS,
  isInTSS,
  calculateCPA,
  getSpeedThreshold,
  checkCollisionRisk,
  checkWrongWayTSS,
  checkMMSIDuplication,
  checkOSINTCorrelation,
  checkAISSpoofingPatterns,
  // DJINN-specific checks (exported for testing)
  checkSTSTransfer,
  checkFastBoatSwarm,
  checkFujairahLoitering,
  checkWrongWayTSSDjinn,
  checkChokepointCongestionDjinn,
  checkStationaryInLaneDjinn,
  checkDarkVesselAppearance,
  isTankerType,
  ZONES,
  TSS_EASTBOUND,
  TSS_WESTBOUND,
  DJINN_ZONES,
  DJINN_CHOKEPOINTS,
  SPEED_THRESHOLDS,
  DARK_TIERS,
  POSITION_JUMP_NM,
  SINGAPORE_LAND,
  BERTH_EXCLUSION_ZONES,
  // Dedup helpers (exported for testing + startup seeding)
  recentAlerts,
  shouldAlert,
  pruneRecentAlerts,
  seedDedupCache,
  _fujairahDwell,
};
