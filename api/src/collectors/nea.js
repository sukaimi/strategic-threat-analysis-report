'use strict';

const config = require('../config');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BASE_URL = config.NEA_BASE_URL || 'https://api.data.gov.sg/v1';

let _timer = null;
let _latestData = null;
let _stats = {
  lastFetchAt: null,
  fetchCount: 0,
  errorCount: 0,
  lastError: null,
};

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
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Extract station metadata (id, name, lat, lon) from a stations array.
 * @param {Array} stations
 * @returns {Map<string, {id: string, name: string, lat: number, lon: number}>}
 */
function buildStationMap(stations) {
  const map = new Map();
  if (!Array.isArray(stations)) return map;
  for (const s of stations) {
    map.set(s.id || s.device_id, {
      id: s.id || s.device_id,
      name: s.name || '',
      lat: s.location?.latitude ?? null,
      lon: s.location?.longitude ?? null,
    });
  }
  return map;
}

/**
 * Merge readings into station metadata.
 * @param {Map} stationMap
 * @param {Array} readings  – [{station_id, value}]
 * @param {string} valueKey – name for the value field in output
 * @returns {Array}
 */
function mergeReadings(stationMap, readings, valueKey) {
  if (!Array.isArray(readings)) return [];
  const result = [];
  for (const r of readings) {
    const station = stationMap.get(r.station_id);
    if (!station) continue;
    result.push({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      [valueKey]: r.value,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main fetch
// ---------------------------------------------------------------------------

async function fetchNeaWeather() {
  const endpoints = [
    `${BASE_URL}/environment/rainfall`,
    `${BASE_URL}/environment/wind-speed`,
    `${BASE_URL}/environment/wind-direction`,
    `${BASE_URL}/environment/air-temperature`,
    `${BASE_URL}/environment/2-hour-weather-forecast`,
  ];

  const results = await Promise.allSettled(endpoints.map((url) => _fetchJson(url)));

  const rainfallData = results[0].status === 'fulfilled' ? results[0].value : null;
  const windSpeedData = results[1].status === 'fulfilled' ? results[1].value : null;
  const windDirData = results[2].status === 'fulfilled' ? results[2].value : null;
  const tempData = results[3].status === 'fulfilled' ? results[3].value : null;
  const forecastData = results[4].status === 'fulfilled' ? results[4].value : null;

  // Log failures
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      console.error('[nea] endpoint %d failed: %s', i, results[i].reason?.message);
    }
  }

  // --- Rainfall ---
  let rainfall = [];
  if (rainfallData) {
    const md = rainfallData.metadata?.stations || [];
    const stationMap = buildStationMap(md);
    const items = rainfallData.items;
    if (Array.isArray(items) && items.length > 0) {
      rainfall = mergeReadings(stationMap, items[0].readings, 'value');
    }
  }

  // --- Wind (merge speed + direction) ---
  let wind = [];
  if (windSpeedData || windDirData) {
    // Build station map from wind-speed metadata (typically same stations)
    const speedStations = windSpeedData?.metadata?.stations || [];
    const dirStations = windDirData?.metadata?.stations || [];
    const stationMap = buildStationMap([...speedStations, ...dirStations]);

    // Speed readings
    const speedReadings = new Map();
    if (windSpeedData?.items?.[0]?.readings) {
      for (const r of windSpeedData.items[0].readings) {
        speedReadings.set(r.station_id, r.value);
      }
    }
    // Direction readings
    const dirReadings = new Map();
    if (windDirData?.items?.[0]?.readings) {
      for (const r of windDirData.items[0].readings) {
        dirReadings.set(r.station_id, r.value);
      }
    }

    // Merge
    const allIds = new Set([...speedReadings.keys(), ...dirReadings.keys()]);
    for (const id of allIds) {
      const station = stationMap.get(id);
      if (!station) continue;
      wind.push({
        id: station.id,
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        speed_kt: speedReadings.get(id) ?? null,
        direction_deg: dirReadings.get(id) ?? null,
      });
    }
  }

  // --- Temperature ---
  let temperature = [];
  if (tempData) {
    const md = tempData.metadata?.stations || [];
    const stationMap = buildStationMap(md);
    const items = tempData.items;
    if (Array.isArray(items) && items.length > 0) {
      temperature = mergeReadings(stationMap, items[0].readings, 'value_c');
    }
  }

  // --- 2-hour forecast ---
  let forecast = [];
  if (forecastData) {
    const items = forecastData.items;
    if (Array.isArray(items) && items.length > 0) {
      const areaMetadata = forecastData.area_metadata || [];
      const areaMap = new Map();
      for (const a of areaMetadata) {
        areaMap.set(a.name, {
          lat: a.label_location?.latitude ?? null,
          lon: a.label_location?.longitude ?? null,
        });
      }
      const forecasts = items[0].forecasts || [];
      for (const f of forecasts) {
        const loc = areaMap.get(f.area) || {};
        forecast.push({
          area: f.area,
          lat: loc.lat ?? null,
          lon: loc.lon ?? null,
          forecast: f.forecast,
        });
      }
    }
  }

  return {
    rainfall,
    wind,
    temperature,
    forecast,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Collector lifecycle
// ---------------------------------------------------------------------------

async function _poll() {
  try {
    _latestData = await fetchNeaWeather();
    _stats.lastFetchAt = new Date().toISOString();
    _stats.fetchCount += 1;
    console.log(
      '[nea] fetched: %d rainfall, %d wind, %d temp, %d forecast stations',
      _latestData.rainfall.length,
      _latestData.wind.length,
      _latestData.temperature.length,
      _latestData.forecast.length
    );
  } catch (err) {
    _stats.errorCount += 1;
    _stats.lastError = err.message;
    console.error('[nea] poll error:', err.message);
  }
}

function start() {
  if (_timer) return;
  console.log('[nea] collector started - polling every 5 min');
  _poll();
  _timer = setInterval(_poll, POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[nea] collector stopped');
  }
}

function getStats() {
  return { ..._stats };
}

function getLatestData() {
  return _latestData;
}

module.exports = {
  start,
  stop,
  getStats,
  getLatestData,
  fetchNeaWeather,
};
