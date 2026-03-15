'use strict';

const { getDb } = require('../db');
const theaters = require('../theaters');

const POLL_INTERVAL_MS = 900000; // 15 minutes

// Per-theater weather endpoints
const THEATER_WEATHER = {
  merlion: {
    openMeteoUrl: 'https://api.open-meteo.com/v1/forecast?latitude=1.29&longitude=103.85&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&hourly=visibility&timezone=Asia/Singapore',
    neaUrl: 'https://api.data.gov.sg/v1/environment/24-hour-weather-forecast',
  },
  djinn: {
    openMeteoUrl: 'https://api.open-meteo.com/v1/forecast?latitude=26.25&longitude=56.25&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&hourly=visibility&timezone=Asia/Dubai',
    neaUrl: null, // No NEA equivalent for Hormuz
  },
};

// Legacy constants kept for backward-compat
const OPEN_METEO_URL = THEATER_WEATHER.merlion.openMeteoUrl;
const NEA_URL = THEATER_WEATHER.merlion.neaUrl;

let _timer = null;
let _stats = {
  lastFetchAt: null,
  fetchCount: 0,
  errorCount: 0,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Convert wind speed from km/h to knots.
 * @param {number|null|undefined} kmh
 * @returns {number|null}
 */
function kmhToKnots(kmh) {
  if (kmh == null || typeof kmh !== 'number' || Number.isNaN(kmh)) return null;
  return Math.round((kmh / 1.852) * 100) / 100;
}

/**
 * Convert visibility from metres to kilometres.
 * @param {number|null|undefined} metres
 * @returns {number|null}
 */
function metresToKm(metres) {
  if (metres == null || typeof metres !== 'number' || Number.isNaN(metres)) return null;
  return Math.round((metres / 1000) * 100) / 100;
}

/**
 * Derive sea-state description from wind speed in knots (Beaufort scale).
 * @param {number|null} knots
 * @returns {string|null}
 */
function deriveSeaState(knots) {
  if (knots == null) return null;
  if (knots <= 1) return 'calm';
  if (knots <= 3) return 'smooth';
  if (knots <= 6) return 'slight';
  if (knots <= 10) return 'moderate';
  if (knots <= 16) return 'rough';
  if (knots <= 21) return 'very rough';
  if (knots <= 27) return 'high';
  return 'very high';
}

/**
 * Estimate cumulonimbus cell presence from WMO weather code.
 * Thunderstorm codes 95, 96, 99 → 1, everything else → 0.
 * @param {number|null|undefined} code
 * @returns {number}
 */
function deriveCbCells(code) {
  if (code == null) return 0;
  return [95, 96, 99].includes(code) ? 1 : 0;
}

/**
 * Combine raw API payloads into a single weather record.
 * @param {object|null} openMeteo  – parsed Open-Meteo JSON
 * @param {object|null} nea        – parsed NEA JSON (reserved for future enrichment)
 * @returns {{ wind_speed_kt: number|null, wind_dir: number|null, visibility_km: number|null, sea_state: string|null, cb_cells: number }}
 */
function parseWeatherData(openMeteo, nea) {
  const current = openMeteo && openMeteo.current ? openMeteo.current : {};
  const hourly = openMeteo && openMeteo.hourly ? openMeteo.hourly : {};

  const windSpeedKmh = current.wind_speed_10m != null ? current.wind_speed_10m : null;
  const windDir = current.wind_direction_10m != null ? current.wind_direction_10m : null;
  const weatherCode = current.weather_code != null ? current.weather_code : null;

  // Use the first hourly visibility entry as the "current" value
  const visibilityMetres =
    Array.isArray(hourly.visibility) && hourly.visibility.length > 0
      ? hourly.visibility[0]
      : null;

  const windSpeedKt = kmhToKnots(windSpeedKmh);
  const visibilityKm = metresToKm(visibilityMetres);
  const seaState = deriveSeaState(windSpeedKt);
  const cbCells = deriveCbCells(weatherCode);

  return {
    wind_speed_kt: windSpeedKt,
    wind_dir: windDir,
    visibility_km: visibilityKm,
    sea_state: seaState,
    cb_cells: cbCells,
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function _fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Main collector logic
// ---------------------------------------------------------------------------

/**
 * Fetch weather data from both sources, parse, and persist to SQLite.
 * @param {string} [theaterKey] - Theater key; defaults to 'merlion'
 * @returns {Promise<object>} the inserted weather record
 */
async function fetchWeather(theaterKey) {
  const tk = theaterKey || 'merlion';
  const weatherCfg = THEATER_WEATHER[tk] || THEATER_WEATHER.merlion;

  let openMeteo = null;
  let nea = null;

  // Build fetch array: Open-Meteo always, NEA only if configured
  const fetches = [_fetchJson(weatherCfg.openMeteoUrl)];
  if (weatherCfg.neaUrl) {
    fetches.push(_fetchJson(weatherCfg.neaUrl));
  }

  // Fetch sources in parallel; tolerate individual failures
  const results = await Promise.allSettled(fetches);

  if (results[0].status === 'fulfilled') {
    openMeteo = results[0].value;
  } else {
    console.error(`[weather] Open-Meteo fetch failed for ${tk}:`, results[0].reason.message);
  }

  if (results.length > 1 && results[1].status === 'fulfilled') {
    nea = results[1].value;
  } else if (results.length > 1) {
    console.error(`[weather] NEA fetch failed for ${tk}:`, results[1].reason.message);
  }

  const record = parseWeatherData(openMeteo, nea);

  // Persist to theater-specific DB
  const db = getDb(tk);
  const stmt = db.prepare(
    'INSERT INTO weather (cb_cells, wind_speed_kt, wind_dir, visibility_km, sea_state) VALUES (?, ?, ?, ?, ?)'
  );
  const info = stmt.run(
    record.cb_cells,
    record.wind_speed_kt,
    record.wind_dir,
    record.visibility_km,
    record.sea_state
  );

  _stats.lastFetchAt = new Date().toISOString();
  _stats.fetchCount += 1;

  return { id: info.lastInsertRowid, ...record };
}

async function _poll() {
  // Poll weather for all configured theaters
  for (const theaterKey of Object.keys(theaters)) {
    try {
      await fetchWeather(theaterKey);
    } catch (err) {
      _stats.errorCount += 1;
      _stats.lastError = `${theaterKey}: ${err.message}`;
      console.error(`[weather] poll error for ${theaterKey}:`, err.message);
    }
  }
}

/**
 * Start the periodic weather collector.
 */
function start() {
  if (_timer) return;
  console.log('[weather] collector started – polling every 15 min');
  // Fire immediately, then every POLL_INTERVAL_MS
  _poll();
  _timer = setInterval(_poll, POLL_INTERVAL_MS);
}

/**
 * Stop the periodic weather collector.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[weather] collector stopped');
  }
}

/**
 * Return runtime statistics for monitoring.
 */
function getStats() {
  return { ..._stats };
}

module.exports = {
  start,
  stop,
  getStats,
  fetchWeather,
  // Exported for unit testing
  kmhToKnots,
  metresToKm,
  deriveSeaState,
  deriveCbCells,
  parseWeatherData,
};
