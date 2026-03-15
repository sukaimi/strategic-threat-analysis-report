'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateETA,
  calculateETAtoSingapore,
  SG_BOARDING_GROUND,
  MAX_DISTANCE_NM,
  MIN_SPEED_KT,
} = require('../src/services/eta');

// ---------------------------------------------------------------------------
// calculateETA
// ---------------------------------------------------------------------------
describe('calculateETA', () => {
  it('calculates ETA for a vessel with valid position and speed', () => {
    const vessel = { lat: 1.30, lon: 103.82, speed_kt: 12, heading: 90 };
    const result = calculateETA(vessel, SG_BOARDING_GROUND.lat, SG_BOARDING_GROUND.lon);
    assert.ok(result, 'Should return a result');
    assert.ok(result.distance_nm > 0, 'Distance should be positive');
    assert.ok(result.eta_minutes > 0, 'ETA should be positive');
  });

  it('returns null for vessel with null position', () => {
    const vessel = { lat: null, lon: null, speed_kt: 12, heading: 90 };
    assert.equal(calculateETA(vessel, 1.0, 103.0), null);
  });

  it('returns null for vessel with zero speed', () => {
    const vessel = { lat: 1.30, lon: 103.82, speed_kt: 0, heading: 90 };
    assert.equal(calculateETA(vessel, 1.0, 103.0), null);
  });

  it('returns null for vessel with null speed', () => {
    const vessel = { lat: 1.30, lon: 103.82, speed_kt: null, heading: 90 };
    assert.equal(calculateETA(vessel, 1.0, 103.0), null);
  });

  it('ETA decreases for faster vessel at same distance', () => {
    const slow = { lat: 2.0, lon: 104.0, speed_kt: 5, heading: 180 };
    const fast = { lat: 2.0, lon: 104.0, speed_kt: 20, heading: 180 };
    const etaSlow = calculateETA(slow, SG_BOARDING_GROUND.lat, SG_BOARDING_GROUND.lon);
    const etaFast = calculateETA(fast, SG_BOARDING_GROUND.lat, SG_BOARDING_GROUND.lon);
    assert.ok(etaFast.eta_minutes < etaSlow.eta_minutes, 'Faster vessel should have shorter ETA');
  });
});

// ---------------------------------------------------------------------------
// calculateETAtoSingapore
// ---------------------------------------------------------------------------
describe('calculateETAtoSingapore', () => {
  it('returns ETA for vessel heading toward Singapore within 100 NM', () => {
    // About 50 NM north, heading south (180)
    const vessel = { lat: 2.05, lon: 103.88, speed_kt: 10, heading: 160 };
    const result = calculateETAtoSingapore(vessel);
    assert.ok(result, 'Should return ETA');
    assert.ok(result.eta_minutes > 0);
    assert.ok(result.distance_nm <= MAX_DISTANCE_NM);
  });

  it('returns null for vessel heading away from Singapore (heading > 180)', () => {
    const vessel = { lat: 1.50, lon: 103.88, speed_kt: 10, heading: 270 };
    assert.equal(calculateETAtoSingapore(vessel), null);
  });

  it('returns null for vessel beyond 100 NM', () => {
    // Very far away
    const vessel = { lat: 5.0, lon: 110.0, speed_kt: 10, heading: 90 };
    assert.equal(calculateETAtoSingapore(vessel), null);
  });

  it('returns null for vessel with null heading', () => {
    const vessel = { lat: 1.50, lon: 103.88, speed_kt: 10, heading: null };
    assert.equal(calculateETAtoSingapore(vessel), null);
  });

  it('returns null for vessel below minimum speed', () => {
    const vessel = { lat: 1.50, lon: 103.88, speed_kt: 0.1, heading: 90 };
    assert.equal(calculateETAtoSingapore(vessel), null);
  });
});
