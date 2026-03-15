'use strict';

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db');
const { getStatus: getCollectorStatus } = require('../collectors');
const { getAIStats } = require('../services/ai');
const { normalizeTimestamps } = require('../utils/normalizeTimestamps');

const router = Router();

router.get('/', (_req, res) => {
  let sqliteOk = false;
  let vaultOk = false;

  // Check SQLite
  let db;
  try {
    db = getDb();
    const row = db.prepare("SELECT 1 AS ok").get();
    sqliteOk = row && row.ok === 1;
  } catch (_e) {
    sqliteOk = false;
  }

  // Check vault path exists and is writable
  try {
    const vaultPath = path.resolve(config.VAULT_PATH);
    fs.accessSync(vaultPath, fs.constants.W_OK);
    vaultOk = true;
  } catch (_e) {
    vaultOk = false;
  }

  // Collector status
  let collectors = {};
  try {
    collectors = getCollectorStatus();
  } catch (_e) {
    // collectors module may not be initialised yet
  }

  // DB row counts
  const dbCounts = { vessels: 0, flights: 0, weather: 0, alerts: 0, analyses: 0 };
  if (sqliteOk && db) {
    try {
      dbCounts.vessels   = (db.prepare('SELECT COUNT(*) AS cnt FROM vessels').get()      || {}).cnt || 0;
      dbCounts.flights   = (db.prepare('SELECT COUNT(*) AS cnt FROM flights').get()      || {}).cnt || 0;
      dbCounts.weather   = (db.prepare('SELECT COUNT(*) AS cnt FROM weather').get()      || {}).cnt || 0;
      dbCounts.alerts    = (db.prepare('SELECT COUNT(*) AS cnt FROM alerts').get()       || {}).cnt || 0;
      dbCounts.analyses  = (db.prepare('SELECT COUNT(*) AS cnt FROM ai_analyses').get()  || {}).cnt || 0;
    } catch (_e) {
      // Tables may not exist yet
    }
  }

  // AI provider info
  let ai = { provider: null, lastAnalysis: null };
  try {
    const aiStats = getAIStats();
    ai.provider = aiStats.activeProvider || aiStats.providerChain?.[0] || null;

    // Get last analysis timestamp from DB
    if (sqliteOk && db) {
      const lastRow = db.prepare('SELECT recorded_at FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1').get();
      const normalized = normalizeTimestamps(lastRow);
      ai.lastAnalysis = normalized?.recorded_at || null;
    }
  } catch (_e) {
    // AI service may not be available
  }

  // Hormuz TSS traffic counter (DJINN enrichment)
  let hormuzTraffic = null;
  try {
    const theaters = require('../theaters');
    const tss = theaters.djinn?.tssLanes;
    if (tss && sqliteOk && db) {
      // Count distinct MMSIs within TSS bounds in the last hour
      const lonMin = tss.inbound.lonMin;
      const lonMax = tss.outbound.lonMax;
      const latMin = tss.inbound.latMin;
      const latMax = tss.outbound.latMax;
      const hormuzRow = db.prepare(
        `SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels
         WHERE lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?
         AND recorded_at >= datetime('now', '-60 minutes')`
      ).get(lonMin, lonMax, latMin, latMax);
      hormuzTraffic = hormuzRow?.cnt ?? 0;
    }
  } catch (_) {}

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      sqlite: sqliteOk,
      vault: vaultOk,
    },
    collectors,
    db: dbCounts,
    ai,
    hormuzTraffic,
  });
});

module.exports = router;
