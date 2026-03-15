'use strict';

const WebSocket = require('ws');
const { getDb } = require('../db');
const config = require('../config');
const sanctions = require('../services/sanctions');
const theaters = require('../theaters');

const AIS_WS_URL = 'wss://stream.aisstream.io/v0/stream';
const BATCH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

// Build bounding boxes from all theater configs for AISStream subscription
// AISStream format: [[latMin, lonMin], [latMax, lonMax]]
const BOUNDING_BOXES = Object.values(theaters).map(t => t.aisStreamBBox);

let _ws = null;
// Per-theater batches: { merlion: [], djinn: [] }
let _batch = {};
let _staticBatch = {};
let _batchTimer = null;
let _reconnectTimer = null;
let _backoffMs = INITIAL_BACKOFF_MS;
let _stopped = false;

// Stats
let _connected = false;
let _messagesReceived = 0;
let _lastMessageAt = null;

// ---------------------------------------------------------------------------
// AIS ship type code → human-readable category mapping
// ---------------------------------------------------------------------------

const AIS_SHIP_TYPE_MAP = {
  // 0-19: not available / reserved
  20: 'Wing in Ground',
  // 30-39: Fishing, Towing, etc.
  30: 'Fishing',
  31: 'Towing',
  32: 'Towing (large)',
  33: 'Dredging',
  34: 'Diving ops',
  35: 'Military ops',
  36: 'Sailing',
  37: 'Pleasure craft',
  // 40-49: High speed craft
  40: 'High speed craft',
  41: 'High speed craft',
  42: 'High speed craft',
  43: 'High speed craft',
  49: 'High speed craft',
  // 50-59: Special craft
  50: 'Pilot vessel',
  51: 'Search and Rescue',
  52: 'Tug',
  53: 'Port tender',
  54: 'Anti-pollution',
  55: 'Law enforcement',
  56: 'Spare local',
  57: 'Spare local',
  58: 'Medical transport',
  59: 'Naval vessel (RR)',
  // 60-69: Passenger
  60: 'Passenger',
  61: 'Passenger',
  62: 'Passenger',
  63: 'Passenger',
  64: 'Passenger',
  65: 'Passenger',
  66: 'Passenger',
  67: 'Passenger',
  68: 'Passenger',
  69: 'Passenger/Ferry',
  // 70-79: Cargo
  70: 'Cargo',
  71: 'Cargo (DG Cat A)',
  72: 'Cargo (DG Cat B)',
  73: 'Cargo (DG Cat C)',
  74: 'Cargo (DG Cat D)',
  75: 'Cargo',
  76: 'Cargo',
  77: 'Cargo',
  78: 'Cargo',
  79: 'Container',
  // 80-89: Tanker
  80: 'Tanker',
  81: 'Tanker (DG Cat A)',
  82: 'Tanker (DG Cat B)',
  83: 'Tanker (DG Cat C)',
  84: 'Tanker (DG Cat D)',
  85: 'Tanker',
  86: 'Tanker',
  87: 'Tanker',
  88: 'Tanker',
  89: 'Tanker',
  // 90-99: Other
  90: 'Other',
  91: 'Other',
  92: 'Other',
  93: 'Other',
  94: 'Other',
  95: 'Other',
  96: 'Other',
  97: 'Other',
  98: 'Other',
  99: 'Other',
};

/**
 * Determine which theater a lat/lon position belongs to.
 * Uses the aisStreamBBox from theater configs: [[latMin, lonMin], [latMax, lonMax]]
 * Returns the theater key or null if no match.
 */
function resolveTheater(lat, lon) {
  if (lat == null || lon == null) return null;
  for (const [key, t] of Object.entries(theaters)) {
    const [[latMin, lonMin], [latMax, lonMax]] = t.aisStreamBBox;
    if (lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax) {
      return key;
    }
  }
  return null;
}

/**
 * Map AIS ship type code (0-99) to a human-readable category string.
 */
function mapShipType(code) {
  if (code == null) return null;
  const num = Number(code);
  if (isNaN(num) || num < 0 || num > 99) return null;

  // Direct lookup
  if (AIS_SHIP_TYPE_MAP[num]) return AIS_SHIP_TYPE_MAP[num];

  // Range-based fallback
  if (num >= 20 && num <= 29) return 'Wing in Ground';
  if (num >= 40 && num <= 49) return 'High speed craft';
  if (num >= 60 && num <= 69) return 'Passenger';
  if (num >= 70 && num <= 79) return 'Cargo';
  if (num >= 80 && num <= 89) return 'Tanker';
  if (num >= 90 && num <= 99) return 'Other';

  return null;
}

/**
 * Parse an AISStream WebSocket message into a flat vessel record.
 * @param {object} msg - Parsed JSON message from AISStream
 * @returns {object|null} Vessel record or null if unparseable
 */
function parseAISMessage(msg) {
  try {
    if (!msg) return null;

    // Handle PositionReport messages
    if (msg.MessageType === 'PositionReport') {
      const meta = msg.MetaData;
      const pos = msg.Message && msg.Message.PositionReport;
      if (!meta || !pos) return null;

      const mmsi = meta.MMSI;
      if (mmsi == null) return null;

      return {
        mmsi: String(mmsi),
        lat: pos.Latitude ?? null,
        lon: pos.Longitude ?? null,
        speed_kt: pos.Sog ?? null,
        heading: (pos.TrueHeading != null && pos.TrueHeading !== 511) ? pos.TrueHeading : null,
        vessel_name: meta.ShipName ? meta.ShipName.trim() : null,
        vessel_type: null,
        time_utc: meta.time_utc || null,
      };
    }

    return null;
  } catch (err) {
    console.error('[AIS] Failed to parse message:', err.message);
    return null;
  }
}

/**
 * Parse AIS Type 5 static/voyage data from ShipStaticData or StaticDataReport messages.
 * @param {object} msg - Parsed JSON message from AISStream
 * @returns {object|null} Static data record or null if unparseable
 */
function parseStaticDataMessage(msg) {
  try {
    if (!msg) return null;

    const msgType = msg.MessageType;
    if (msgType !== 'ShipStaticData' && msgType !== 'StaticDataReport') return null;

    const meta = msg.MetaData;
    if (!meta || meta.MMSI == null) return null;

    const payload = (msg.Message && (msg.Message.ShipStaticData || msg.Message.StaticDataReport)) || {};

    const aisTypeCode = payload.Type ?? payload.ShipType ?? null;

    return {
      mmsi: String(meta.MMSI),
      vessel_name: meta.ShipName ? meta.ShipName.trim() : (payload.Name ? payload.Name.trim() : null),
      vessel_type: mapShipType(aisTypeCode),
      ais_type_code: aisTypeCode,
      imo_number: payload.ImoNumber ? String(payload.ImoNumber) : null,
      destination: payload.Destination ? payload.Destination.trim() : null,
      draught: payload.MaximumStaticDraught ?? payload.Draught ?? null,
      length: payload.Dimension ? (payload.Dimension.A + payload.Dimension.B) : null,
      breadth: payload.Dimension ? (payload.Dimension.C + payload.Dimension.D) : null,
      call_sign: payload.CallSign ? payload.CallSign.trim() : null,
      time_utc: meta.time_utc || null,
    };
  } catch (err) {
    console.error('[AIS] Failed to parse static data message:', err.message);
    return null;
  }
}

/**
 * Flush the accumulated per-theater batches of vessel records to SQLite.
 */
function flushBatch() {
  const theaterKeys = new Set([...Object.keys(_batch), ...Object.keys(_staticBatch)]);
  if (theaterKeys.size === 0) return;

  for (const theaterKey of theaterKeys) {
    const records = (_batch[theaterKey] || []).splice(0);
    const staticRecords = (_staticBatch[theaterKey] || []).splice(0);
    const count = records.length;
    const staticCount = staticRecords.length;

    if (count === 0 && staticCount === 0) continue;

    try {
      const db = getDb(theaterKey);

      // Insert position records (deduplicated: keep latest per MMSI in batch)
      if (records.length > 0) {
        const dedupMap = new Map();
        for (const row of records) {
          dedupMap.set(row.mmsi, row);
        }
        const dedupRecords = Array.from(dedupMap.values());

        const insert = db.prepare(`
          INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type)
          VALUES (@mmsi, @lat, @lon, @speed_kt, @heading, @vessel_name, @vessel_type)
        `);

        const insertMany = db.transaction((rows) => {
          for (const row of rows) {
            insert.run(row);
          }
        });

        insertMany(dedupRecords);
      }

      // Update static data (upsert: update the most recent record for each MMSI)
      if (staticRecords.length > 0) {
        const updateStatic = db.prepare(`
          UPDATE vessels SET
            vessel_type = COALESCE(?, vessel_type),
            imo_number = COALESCE(?, imo_number),
            destination = COALESCE(?, destination),
            draught = COALESCE(?, draught),
            length = COALESCE(?, length),
            breadth = COALESCE(?, breadth),
            call_sign = COALESCE(?, call_sign),
            vessel_name = COALESCE(?, vessel_name)
          WHERE mmsi = ? AND id = (
            SELECT id FROM vessels WHERE mmsi = ? ORDER BY recorded_at DESC LIMIT 1
          )
        `);

        const updateMany = db.transaction((rows) => {
          for (const row of rows) {
            updateStatic.run(
              row.vessel_type, row.imo_number, row.destination,
              row.draught, row.length, row.breadth, row.call_sign,
              row.vessel_name,
              row.mmsi, row.mmsi
            );
          }
        });

        updateMany(staticRecords);
      }

      // Screen batch against sanctions list
      try {
        const matches = sanctions.screenBatch(records);
        if (matches.length > 0) {
          const flagStmt = db.prepare('UPDATE vessels SET flagged = 1 WHERE mmsi = ?');
          const alertStmt = db.prepare(
            'INSERT INTO alerts (severity, title, description, entity_mmsi) VALUES (?, ?, ?, ?)'
          );
          for (const m of matches) {
            const hit = m.result.hits[0];
            flagStmt.run(m.mmsi);
            alertStmt.run(
              'CRITICAL',
              'Sanctions Match Detected',
              `Vessel "${m.vessel_name || m.mmsi}" matched ${hit.list_source} sanctions list (${hit.reason})`.slice(0, 500),
              m.mmsi
            );
            console.log(`[AIS] SANCTIONS MATCH: MMSI ${m.mmsi} (${hit.list_source}) [${theaterKey}]`);
          }
        }
      } catch (err) {
        console.error('[AIS] Sanctions screening error:', err.message);
      }

      if (count > 0) console.log(`[AIS] Flushed ${count} vessel positions to ${theaterKey} DB`);
      if (staticCount > 0) console.log(`[AIS] Updated ${staticCount} vessel static records in ${theaterKey} DB`);
    } catch (err) {
      console.error(`[AIS] Batch write failed for ${theaterKey} (${count} position + ${staticCount} static records lost):`, err.message);
    }
  }
}

/**
 * Establish the WebSocket connection and wire up handlers.
 */
function connect() {
  if (_stopped) return;

  const apiKey = config.AISSTREAM_API_KEY;
  if (!apiKey) {
    console.error('[AIS] AISSTREAM_API_KEY not set; collector will not start');
    return;
  }

  console.log('[AIS] Connecting to AISStream...');
  _ws = new WebSocket(AIS_WS_URL);

  _ws.on('open', () => {
    console.log('[AIS] Connected');
    _connected = true;
    _backoffMs = INITIAL_BACKOFF_MS; // reset backoff on successful connection

    const subscription = {
      APIKey: apiKey,
      BoundingBoxes: BOUNDING_BOXES,
      FiltersShipMMSI: [],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StaticDataReport'],
    };

    _ws.send(JSON.stringify(subscription));
    console.log('[AIS] Subscription sent');
  });

  _ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Try position report first
      const record = parseAISMessage(msg);
      if (record) {
        const theater = resolveTheater(record.lat, record.lon) || 'merlion';
        if (!_batch[theater]) _batch[theater] = [];
        _batch[theater].push(record);
        _messagesReceived++;
        _lastMessageAt = new Date().toISOString();
        return;
      }

      // Try static data — route using MetaData lat/lon if available
      const staticRecord = parseStaticDataMessage(msg);
      if (staticRecord) {
        // Static data may not have position; use MetaData lat/lon or default to merlion
        const meta = msg.MetaData;
        const lat = meta && meta.latitude != null ? meta.latitude : null;
        const lon = meta && meta.longitude != null ? meta.longitude : null;
        const theater = resolveTheater(lat, lon) || 'merlion';
        if (!_staticBatch[theater]) _staticBatch[theater] = [];
        _staticBatch[theater].push(staticRecord);
        _messagesReceived++;
        _lastMessageAt = new Date().toISOString();
      }
    } catch (err) {
      console.error('[AIS] Error processing message:', err.message);
    }
  });

  _ws.on('close', (code, reason) => {
    _connected = false;
    const reasonStr = reason ? reason.toString() : 'unknown';
    console.log(`[AIS] Connection closed (code=${code}, reason=${reasonStr})`);
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    console.error('[AIS] WebSocket error:', err.message);
    // 'close' event will fire after this, triggering reconnect
  });
}

/**
 * Schedule a reconnection with exponential backoff.
 */
function scheduleReconnect() {
  if (_stopped) return;

  console.log(`[AIS] Reconnecting in ${_backoffMs}ms...`);
  _reconnectTimer = setTimeout(() => {
    _backoffMs = Math.min(_backoffMs * 2, MAX_BACKOFF_MS);
    connect();
  }, _backoffMs);
}

/**
 * Calculate the next backoff value (exposed for testing).
 * @param {number} current - Current backoff in ms
 * @returns {number} Next backoff in ms
 */
function nextBackoff(current) {
  return Math.min(current * 2, MAX_BACKOFF_MS);
}

/**
 * Start the AIS collector: connect to WebSocket and begin batch flush timer.
 */
function start() {
  _stopped = false;
  _messagesReceived = 0;
  _lastMessageAt = null;
  _batch = {};
  _staticBatch = {};
  _backoffMs = INITIAL_BACKOFF_MS;

  connect();

  _batchTimer = setInterval(() => {
    flushBatch();
  }, BATCH_INTERVAL_MS);

  console.log('[AIS] Collector started');
}

/**
 * Stop the AIS collector: close WebSocket and flush remaining batch.
 */
function stop() {
  _stopped = true;

  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  if (_batchTimer) {
    clearInterval(_batchTimer);
    _batchTimer = null;
  }

  if (_ws) {
    _ws.removeAllListeners();
    _ws.close();
    _ws = null;
  }

  _connected = false;

  // Flush any remaining records
  flushBatch();

  console.log('[AIS] Collector stopped');
}

/**
 * Return current collector statistics.
 * @returns {{ connected: boolean, messagesReceived: number, lastMessageAt: string|null, batchSize: number }}
 */
function getStats() {
  const totalBatch = Object.values(_batch).reduce((sum, arr) => sum + arr.length, 0);
  const totalStaticBatch = Object.values(_staticBatch).reduce((sum, arr) => sum + arr.length, 0);
  return {
    connected: _connected,
    messagesReceived: _messagesReceived,
    lastMessageAt: _lastMessageAt,
    batchSize: totalBatch,
    staticBatchSize: totalStaticBatch,
  };
}

module.exports = {
  start,
  stop,
  getStats,
  // Exported for unit testing
  parseAISMessage,
  parseStaticDataMessage,
  mapShipType,
  flushBatch,
  nextBackoff,
  resolveTheater,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  AIS_SHIP_TYPE_MAP,
  // Expose internals for testing via getter
  // _getBatch returns a flat array (all theaters combined) for backward compat
  _getBatch: () => {
    const all = [];
    for (const arr of Object.values(_batch)) all.push(...arr);
    return all;
  },
  _getBatchByTheater: () => _batch,
  _pushBatch: (record) => {
    const theater = resolveTheater(record.lat, record.lon) || 'merlion';
    if (!_batch[theater]) _batch[theater] = [];
    _batch[theater].push(record);
  },
  _resetBatch: () => { _batch = {}; _staticBatch = {}; },
  _getStaticBatch: () => {
    const all = [];
    for (const arr of Object.values(_staticBatch)) all.push(...arr);
    return all;
  },
  _getStaticBatchByTheater: () => _staticBatch,
  _pushStaticBatch: (record) => {
    // Default to merlion for static data without position
    if (!_staticBatch.merlion) _staticBatch.merlion = [];
    _staticBatch.merlion.push(record);
  },
};
