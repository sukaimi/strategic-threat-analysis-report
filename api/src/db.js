'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * Map of theater key -> Database instance.
 * Legacy singleton is stored under the key of the active theater (or '_default').
 */
const _dbs = new Map();

/**
 * Resolve the DB file path for a given theater key.
 * Falls back to env/config/default if no theater key provided.
 */
function _resolveDbPath(theaterKey) {
  if (theaterKey === ':memory:') return ':memory:';

  // If a theater key is given, look up its config
  if (theaterKey) {
    try {
      const theaters = require('./theaters');
      if (theaters[theaterKey]) {
        return theaters[theaterKey].dbPath;
      }
    } catch (_) {
      // theaters module may not be available in tests
    }
  }

  return process.env.SQLITE_DB_PATH || './data/spectre.db';
}

/**
 * Initialise (or return the existing) SQLite connection.
 * @param {string} [theaterKeyOrPath] - Theater key ('merlion', 'djinn'), explicit path, or ':memory:'
 * @returns {import('better-sqlite3').Database}
 */
function getDb(theaterKeyOrPath) {
  // Determine the cache key and resolved path
  let cacheKey;
  let resolvedPath;

  if (theaterKeyOrPath === ':memory:') {
    // In-memory DB for tests — use legacy singleton behavior
    cacheKey = '_memory';
    resolvedPath = ':memory:';
  } else if (theaterKeyOrPath && (theaterKeyOrPath.includes('/') || theaterKeyOrPath.includes('\\'))) {
    // Explicit file path passed (legacy behavior)
    cacheKey = '_default';
    resolvedPath = theaterKeyOrPath;
  } else {
    // Theater key or default
    const theaters = (() => { try { return require('./theaters'); } catch (_) { return null; } })();
    const key = theaterKeyOrPath || ((() => { try { return require('./config').ACTIVE_THEATER; } catch (_) { return 'merlion'; } })());

    if (theaters && theaters[key]) {
      cacheKey = key;
      resolvedPath = theaters[key].dbPath;
    } else if (!theaterKeyOrPath) {
      // No theater key, no match — use default singleton
      cacheKey = '_default';
      resolvedPath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../../data/spectre.db');
    } else {
      // Unknown theater key — treat as default
      cacheKey = '_default';
      resolvedPath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../../data/spectre.db');
    }
  }

  // Test mode: if an in-memory DB was opened, always return it
  // (prevents theater middleware from opening real DB files during tests)
  if (cacheKey !== '_memory' && _dbs.has('_memory')) {
    return _dbs.get('_memory');
  }

  // Return cached instance if available
  if (_dbs.has(cacheKey)) return _dbs.get(cacheKey);

  // Resolve relative paths against the project root
  if (resolvedPath !== ':memory:' && !path.isAbsolute(resolvedPath)) {
    resolvedPath = path.resolve(__dirname, '../..', resolvedPath);
  }

  // Ensure parent directory exists (skip for in-memory)
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');

  _bootstrap(db);

  _dbs.set(cacheKey, db);
  return db;
}

/**
 * Create all tables and indexes if they do not already exist.
 * @param {import('better-sqlite3').Database} db
 */
function _bootstrap(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vessels (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      mmsi         TEXT NOT NULL,
      lat          REAL,
      lon          REAL,
      speed_kt     REAL,
      heading      REAL,
      vessel_name  TEXT,
      vessel_type  TEXT,
      flagged      INTEGER DEFAULT 0,
      imo_number   TEXT,
      destination  TEXT,
      draught      REAL,
      length       REAL,
      breadth      REAL,
      call_sign    TEXT,
      recorded_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS flights (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      callsign     TEXT,
      squawk       TEXT,
      lat          REAL,
      lon          REAL,
      altitude_ft  REAL,
      speed_kt     REAL,
      heading      REAL,
      recorded_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weather (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cb_cells      INTEGER,
      wind_speed_kt REAL,
      wind_dir      REAL,
      visibility_km REAL,
      sea_state     TEXT,
      recorded_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS port_status (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      vessels_queued    INTEGER,
      berth_utilisation REAL,
      channel_flow_pct  REAL,
      recorded_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_analyses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      composite_score REAL,
      threat_json     TEXT,
      tactical_brief  TEXT,
      recorded_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      severity         TEXT CHECK(severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
      title            TEXT,
      description      TEXT,
      entity_mmsi      TEXT,
      entity_callsign  TEXT,
      acknowledged     INTEGER DEFAULT 0,
      flagged          INTEGER DEFAULT 0,
      status           TEXT DEFAULT 'NEW' CHECK(status IN ('NEW','ACKNOWLEDGED','INVESTIGATING','RESOLVED')),
      assigned_to      TEXT,
      resolution_notes TEXT,
      resolved_at      TEXT,
      category         TEXT CHECK(category IN ('SECURITY','SAFETY','NAVIGATIONAL','OPERATIONAL','INFORMATIONAL','SANCTIONS')),
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vessels_mmsi_recorded
      ON vessels(mmsi, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_vessels_recorded
      ON vessels(recorded_at);

    CREATE INDEX IF NOT EXISTS idx_flights_callsign_recorded
      ON flights(callsign, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_flights_recorded
      ON flights(recorded_at);

    CREATE INDEX IF NOT EXISTS idx_alerts_severity_created
      ON alerts(severity, created_at);

    CREATE INDEX IF NOT EXISTS idx_alerts_ack_created
      ON alerts(acknowledged, created_at);

    CREATE INDEX IF NOT EXISTS idx_analyses_recorded
      ON ai_analyses(recorded_at);

    -- RBAC: users and sessions
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role         TEXT NOT NULL CHECK(role IN ('operator','analyst','commander','admin')),
      created_at   TEXT DEFAULT (datetime('now')),
      last_login   TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token        TEXT NOT NULL UNIQUE,
      expires_at   TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    -- OSINT intelligence articles
    CREATE TABLE IF NOT EXISTS intel_articles (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL,
      guid            TEXT NOT NULL,
      title           TEXT,
      link            TEXT,
      summary         TEXT,
      published_at    TEXT,
      relevance_score INTEGER DEFAULT 0,
      entities_json   TEXT,
      dedup_hash      TEXT UNIQUE,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_intel_dedup ON intel_articles(dedup_hash);

    -- LLM usage tracking
    CREATE TABLE IF NOT EXISTS ai_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      provider        TEXT NOT NULL,
      model           TEXT,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      total_tokens    INTEGER DEFAULT 0,
      cost_usd        REAL DEFAULT 0,
      duration_ms     INTEGER DEFAULT 0,
      success         INTEGER DEFAULT 1,
      error_msg       TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_intel_relevance ON intel_articles(relevance_score, created_at);

    -- NASA FIRMS thermal/fire detections (DJINN theater enrichment)
    CREATE TABLE IF NOT EXISTS thermal_detections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lat REAL,
      lon REAL,
      brightness REAL,
      confidence TEXT,
      frp REAL,
      satellite TEXT,
      detected_at TEXT,
      dedup_hash TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_thermal_detected ON thermal_detections(detected_at);
    CREATE INDEX IF NOT EXISTS idx_thermal_dedup ON thermal_detections(dedup_hash);
  `);

  // Seed default admin user on first boot
  _seedDefaultAdmin(db);
}

/**
 * Seed a default admin user if the users table is empty.
 */
function _seedDefaultAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  if (count > 0) return;

  try {
    const bcrypt = require('bcryptjs');
    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'changeme';
    const hash = bcrypt.hashSync(defaultPassword, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin', hash, 'admin');
    console.log('[db] Seeded default admin user (username: admin)');
  } catch (err) {
    console.error('[db] Failed to seed admin user:', err.message);
  }
}

/**
 * Delete records older than 72 hours from high-volume tables.
 * @param {string} [theaterKey] - Theater key; defaults to active theater
 * @returns {{ vessels: number, flights: number, weather: number, port_status: number }} rows deleted per table
 */
function purge72h(theaterKey) {
  const db = getDb(theaterKey);
  const cutoff = "datetime('now', '-72 hours')";

  const tables = ['vessels', 'flights', 'weather', 'port_status', 'alerts', 'ai_analyses', 'thermal_detections'];
  const tsCol = { vessels: 'recorded_at', flights: 'recorded_at', weather: 'recorded_at', port_status: 'recorded_at', alerts: 'created_at', ai_analyses: 'recorded_at', thermal_detections: 'created_at' };

  const result = {};
  for (const table of tables) {
    const col = tsCol[table];
    const info = db.prepare(`DELETE FROM ${table} WHERE ${col} < ${cutoff}`).run();
    result[table] = info.changes;
  }
  return result;
}

/**
 * Close all database connections and reset the cache.
 */
function close() {
  for (const [, db] of _dbs) {
    try { db.close(); } catch (_) {}
  }
  _dbs.clear();
}

module.exports = { getDb, close, purge72h };
