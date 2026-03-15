'use strict';

const { haversineNm } = require('./anomaly');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Singapore Pilotage Boarding Ground
const SG_BOARDING_GROUND = { lat: 1.2230, lon: 103.8850 };

// Maximum distance to consider for ETA calculation (NM)
const MAX_DISTANCE_NM = 100;

// Heading range: vessels heading roughly toward Singapore (0-180 degrees)
const HEADING_MIN = 0;
const HEADING_MAX = 180;

// Minimum speed to calculate ETA (knots)
const MIN_SPEED_KT = 0.5;

/**
 * Calculate great-circle distance and ETA from a vessel's current position to a target.
 *
 * @param {{ lat: number|null, lon: number|null, speed_kt: number|null, heading: number|null }} vessel
 * @param {number} targetLat
 * @param {number} targetLon
 * @returns {{ distance_nm: number, eta_minutes: number }|null} null if unable to compute
 */
function calculateETA(vessel, targetLat, targetLon) {
  if (vessel.lat == null || vessel.lon == null) return null;
  if (vessel.speed_kt == null || vessel.speed_kt < MIN_SPEED_KT) return null;

  const distance = haversineNm(vessel.lat, vessel.lon, targetLat, targetLon);
  const etaMinutes = (distance / vessel.speed_kt) * 60;

  return {
    distance_nm: Math.round(distance * 10) / 10,
    eta_minutes: Math.round(etaMinutes),
  };
}

/**
 * Check whether a vessel qualifies for ETA to Singapore Boarding Ground:
 * - heading roughly 0-180 degrees
 * - within 100 NM of target
 *
 * @param {{ lat: number|null, lon: number|null, speed_kt: number|null, heading: number|null }} vessel
 * @returns {{ distance_nm: number, eta_minutes: number }|null}
 */
function calculateETAtoSingapore(vessel) {
  if (vessel.lat == null || vessel.lon == null) return null;
  if (vessel.heading == null) return null;
  if (vessel.speed_kt == null || vessel.speed_kt < MIN_SPEED_KT) return null;

  // Heading filter: roughly toward Singapore
  if (vessel.heading < HEADING_MIN || vessel.heading > HEADING_MAX) return null;

  const distance = haversineNm(vessel.lat, vessel.lon, SG_BOARDING_GROUND.lat, SG_BOARDING_GROUND.lon);
  if (distance > MAX_DISTANCE_NM) return null;

  const etaMinutes = (distance / vessel.speed_kt) * 60;

  return {
    distance_nm: Math.round(distance * 10) / 10,
    eta_minutes: Math.round(etaMinutes),
  };
}

module.exports = {
  calculateETA,
  calculateETAtoSingapore,
  SG_BOARDING_GROUND,
  MAX_DISTANCE_NM,
  MIN_SPEED_KT,
};
