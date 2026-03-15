'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  kmhToKnots,
  metresToKm,
  deriveSeaState,
  deriveCbCells,
  parseWeatherData,
} = require('../src/collectors/weather');

// ---------------------------------------------------------------------------
// kmhToKnots
// ---------------------------------------------------------------------------
describe('kmhToKnots', () => {
  it('converts km/h to knots correctly', () => {
    // 1.852 km/h = 1 knot
    assert.equal(kmhToKnots(1.852), 1);
    assert.equal(kmhToKnots(0), 0);
  });

  it('rounds to two decimal places', () => {
    // 15.2 km/h → 15.2 / 1.852 ≈ 8.21
    const result = kmhToKnots(15.2);
    assert.equal(result, 8.21);
  });

  it('returns null for null/undefined/NaN', () => {
    assert.equal(kmhToKnots(null), null);
    assert.equal(kmhToKnots(undefined), null);
    assert.equal(kmhToKnots(NaN), null);
  });

  it('returns null for non-number types', () => {
    assert.equal(kmhToKnots('fast'), null);
  });
});

// ---------------------------------------------------------------------------
// metresToKm
// ---------------------------------------------------------------------------
describe('metresToKm', () => {
  it('converts metres to kilometres correctly', () => {
    assert.equal(metresToKm(1000), 1);
    assert.equal(metresToKm(24140), 24.14);
    assert.equal(metresToKm(0), 0);
  });

  it('rounds to two decimal places', () => {
    assert.equal(metresToKm(1234), 1.23);
  });

  it('returns null for null/undefined/NaN', () => {
    assert.equal(metresToKm(null), null);
    assert.equal(metresToKm(undefined), null);
    assert.equal(metresToKm(NaN), null);
  });
});

// ---------------------------------------------------------------------------
// deriveSeaState
// ---------------------------------------------------------------------------
describe('deriveSeaState', () => {
  it('returns "calm" for 0-1 knots', () => {
    assert.equal(deriveSeaState(0), 'calm');
    assert.equal(deriveSeaState(0.5), 'calm');
    assert.equal(deriveSeaState(1), 'calm');
  });

  it('returns "smooth" for 1-3 knots', () => {
    assert.equal(deriveSeaState(1.5), 'smooth');
    assert.equal(deriveSeaState(3), 'smooth');
  });

  it('returns "slight" for 4-6 knots', () => {
    assert.equal(deriveSeaState(4), 'slight');
    assert.equal(deriveSeaState(6), 'slight');
  });

  it('returns "moderate" for 7-10 knots', () => {
    assert.equal(deriveSeaState(7), 'moderate');
    assert.equal(deriveSeaState(10), 'moderate');
  });

  it('returns "rough" for 11-16 knots', () => {
    assert.equal(deriveSeaState(11), 'rough');
    assert.equal(deriveSeaState(16), 'rough');
  });

  it('returns "very rough" for 17-21 knots', () => {
    assert.equal(deriveSeaState(17), 'very rough');
    assert.equal(deriveSeaState(21), 'very rough');
  });

  it('returns "high" for 22-27 knots', () => {
    assert.equal(deriveSeaState(22), 'high');
    assert.equal(deriveSeaState(27), 'high');
  });

  it('returns "very high" for 28+ knots', () => {
    assert.equal(deriveSeaState(28), 'very high');
    assert.equal(deriveSeaState(50), 'very high');
  });

  it('returns null for null input', () => {
    assert.equal(deriveSeaState(null), null);
  });
});

// ---------------------------------------------------------------------------
// deriveCbCells
// ---------------------------------------------------------------------------
describe('deriveCbCells', () => {
  it('returns 1 for thunderstorm codes 95, 96, 99', () => {
    assert.equal(deriveCbCells(95), 1);
    assert.equal(deriveCbCells(96), 1);
    assert.equal(deriveCbCells(99), 1);
  });

  it('returns 0 for non-thunderstorm codes', () => {
    assert.equal(deriveCbCells(0), 0);
    assert.equal(deriveCbCells(1), 0);
    assert.equal(deriveCbCells(61), 0);
    assert.equal(deriveCbCells(80), 0);
  });

  it('returns 0 for null/undefined', () => {
    assert.equal(deriveCbCells(null), 0);
    assert.equal(deriveCbCells(undefined), 0);
  });
});

// ---------------------------------------------------------------------------
// parseWeatherData
// ---------------------------------------------------------------------------
describe('parseWeatherData', () => {
  it('correctly combines Open-Meteo data', () => {
    const openMeteo = {
      current: {
        temperature_2m: 31.5,
        wind_speed_10m: 15.2,
        wind_direction_10m: 225,
        weather_code: 61,
      },
      hourly: {
        visibility: [24140, 20000, 18000],
      },
    };

    const result = parseWeatherData(openMeteo, null);

    assert.equal(result.wind_speed_kt, 8.21);
    assert.equal(result.wind_dir, 225);
    assert.equal(result.visibility_km, 24.14);
    assert.equal(result.sea_state, 'moderate');
    assert.equal(result.cb_cells, 0);
  });

  it('detects thunderstorm cb_cells', () => {
    const openMeteo = {
      current: {
        wind_speed_10m: 30,
        wind_direction_10m: 180,
        weather_code: 95,
      },
      hourly: { visibility: [10000] },
    };

    const result = parseWeatherData(openMeteo, null);
    assert.equal(result.cb_cells, 1);
  });

  it('handles completely null/missing Open-Meteo gracefully', () => {
    const result = parseWeatherData(null, null);

    assert.equal(result.wind_speed_kt, null);
    assert.equal(result.wind_dir, null);
    assert.equal(result.visibility_km, null);
    assert.equal(result.sea_state, null);
    assert.equal(result.cb_cells, 0);
  });

  it('handles empty current and hourly objects', () => {
    const result = parseWeatherData({ current: {}, hourly: {} }, null);

    assert.equal(result.wind_speed_kt, null);
    assert.equal(result.wind_dir, null);
    assert.equal(result.visibility_km, null);
    assert.equal(result.sea_state, null);
    assert.equal(result.cb_cells, 0);
  });

  it('handles empty visibility array', () => {
    const openMeteo = {
      current: { wind_speed_10m: 10, wind_direction_10m: 90, weather_code: 0 },
      hourly: { visibility: [] },
    };

    const result = parseWeatherData(openMeteo, null);
    assert.equal(result.visibility_km, null);
    assert.equal(result.wind_speed_kt, 5.4);
    assert.equal(result.wind_dir, 90);
  });

  it('ignores NEA data without crashing (reserved for future use)', () => {
    const openMeteo = {
      current: { wind_speed_10m: 5, wind_direction_10m: 0, weather_code: 1 },
      hourly: { visibility: [5000] },
    };
    const nea = { items: [{ general: { forecast: 'Partly Cloudy' } }] };

    const result = parseWeatherData(openMeteo, nea);
    assert.equal(result.wind_speed_kt, 2.7);
    assert.equal(result.visibility_km, 5);
    assert.equal(result.cb_cells, 0);
  });
});
