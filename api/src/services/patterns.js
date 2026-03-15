'use strict';

const { haversineNm } = require('./anomaly');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASELINE_HOURS = 72;
const MIN_DATA_POINTS = 10;
const SPEED_DEVIATION_FACTOR = 2;    // flag if current speed > 2x average
const POSITION_DEVIATION_NM = 20;    // flag if position > 20 NM outside bbox

/**
 * Build a pattern-of-life baseline for a given MMSI from the last 72 hours.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} mmsi
 * @returns {{ avgSpeed: number, minSpeed: number, maxSpeed: number, headingRange: [number, number], bbox: { latMin: number, latMax: number, lonMin: number, lonMax: number }, dataPoints: number, hourDistribution: number[] }|null}
 */
function buildBaseline(db, mmsi) {
  const rows = db.prepare(`
    SELECT lat, lon, speed_kt, heading, recorded_at
    FROM vessels
    WHERE mmsi = ? AND recorded_at >= datetime('now', '-${BASELINE_HOURS} hours')
      AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY recorded_at ASC
  `).all(mmsi);

  if (rows.length < MIN_DATA_POINTS) return null;

  let speedSum = 0;
  let speedCount = 0;
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let minHeading = Infinity;
  let maxHeading = -Infinity;
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  const hourDistribution = new Array(24).fill(0);

  for (const r of rows) {
    if (r.lat < latMin) latMin = r.lat;
    if (r.lat > latMax) latMax = r.lat;
    if (r.lon < lonMin) lonMin = r.lon;
    if (r.lon > lonMax) lonMax = r.lon;

    if (r.speed_kt != null) {
      speedSum += r.speed_kt;
      speedCount++;
      if (r.speed_kt < minSpeed) minSpeed = r.speed_kt;
      if (r.speed_kt > maxSpeed) maxSpeed = r.speed_kt;
    }

    if (r.heading != null) {
      if (r.heading < minHeading) minHeading = r.heading;
      if (r.heading > maxHeading) maxHeading = r.heading;
    }

    // Extract hour from recorded_at
    try {
      const dt = new Date(r.recorded_at);
      const hour = dt.getUTCHours();
      hourDistribution[hour]++;
    } catch (_) { /* ignore parse errors */ }
  }

  return {
    avgSpeed: speedCount > 0 ? Math.round((speedSum / speedCount) * 100) / 100 : 0,
    minSpeed: minSpeed === Infinity ? 0 : minSpeed,
    maxSpeed: maxSpeed === -Infinity ? 0 : maxSpeed,
    headingRange: [
      minHeading === Infinity ? 0 : minHeading,
      maxHeading === -Infinity ? 360 : maxHeading,
    ],
    bbox: { latMin, latMax, lonMin, lonMax },
    dataPoints: rows.length,
    hourDistribution,
  };
}

/**
 * Check whether a vessel's current behavior deviates from its baseline.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} mmsi
 * @param {{ lat: number, lon: number, speed_kt: number|null }} currentPosition
 * @returns {{ deviations: string[], baseline: object }|null} null if insufficient history
 */
function checkDeviation(db, mmsi, currentPosition) {
  const baseline = buildBaseline(db, mmsi);
  if (!baseline) return null;

  const deviations = [];

  // Speed deviation: current > 2x average
  if (
    currentPosition.speed_kt != null &&
    baseline.avgSpeed > 0 &&
    currentPosition.speed_kt > baseline.avgSpeed * SPEED_DEVIATION_FACTOR
  ) {
    deviations.push(
      `Speed ${currentPosition.speed_kt.toFixed(1)} kt exceeds 2x baseline average (${baseline.avgSpeed.toFixed(1)} kt)`
    );
  }

  // Position deviation: outside bounding box by more than 20 NM
  if (currentPosition.lat != null && currentPosition.lon != null) {
    const bbox = baseline.bbox;
    // Find closest point on bbox to current position
    const clampedLat = Math.max(bbox.latMin, Math.min(bbox.latMax, currentPosition.lat));
    const clampedLon = Math.max(bbox.lonMin, Math.min(bbox.lonMax, currentPosition.lon));
    const distOutside = haversineNm(currentPosition.lat, currentPosition.lon, clampedLat, clampedLon);

    if (distOutside > POSITION_DEVIATION_NM) {
      deviations.push(
        `Position ${distOutside.toFixed(1)} NM outside typical operating area`
      );
    }
  }

  return { deviations, baseline };
}

module.exports = {
  buildBaseline,
  checkDeviation,
  BASELINE_HOURS,
  MIN_DATA_POINTS,
  SPEED_DEVIATION_FACTOR,
  POSITION_DEVIATION_NM,
};
