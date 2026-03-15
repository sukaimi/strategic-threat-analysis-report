'use strict';

const app = require('./app');
const config = require('./config');
const { getDb, purge72h } = require('./db');
const collectors = require('./collectors');
const ai = require('./services/ai');
const vault = require('./services/vault');
const { runAnomalyChecks, runAllTheaterAnomalyChecks, seedDedupCache } = require('./services/anomaly');
const theaters = require('./theaters');
const { createBridge } = require('./services/bridge');
const { createServer: createWsServer } = require('../../ws/src/server');
const scheduler = require('../../cron/src/scheduler');
const { startEscalationTimer } = require('./services/escalation');
const { runCrossTheaterCheck } = require('./services/crossTheater');
const { normalizeTimestamps, normalizeTimestampsArray } = require('./utils/normalizeTimestamps');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Start WebSocket server first so we can wire the bridge
  const ws = await createWsServer({
    port: Number(config.PORT_WS) || 3002,
    onConnect: (client) => sendInitialSnapshot(client),
  });
  const { events } = createBridge(ws.broadcast);

  // Start HTTP API
  app.listen(config.PORT_API, () => {
    console.log(`[star-merlion] API server listening on port ${config.PORT_API}`);
    console.log(`[star-merlion] Environment: ${config.NODE_ENV}`);
    console.log(`[star-merlion] Domain: ${config.DOMAIN}`);
  });

  // Ensure ALL theater DBs are initialised (bootstrap tables)
  for (const key of Object.keys(theaters)) {
    getDb(key);
    console.log(`[star-merlion] Bootstrapped DB for theater: ${key}`);
  }

  // Start all data collectors (AIS, flights, weather, port)
  collectors.startAll();

  // Schedule AI analysis cycle for all theaters (default 120 min)
  runAllTheaterAnalysisCycles(events);
  const aiIntervalMs = config.AI_ANALYSIS_INTERVAL_MIN * 60 * 1000;
  setInterval(() => runAllTheaterAnalysisCycles(events), aiIntervalMs);
  console.log(`[star-merlion] AI analysis interval: ${config.AI_ANALYSIS_INTERVAL_MIN} min (all theaters)`);

  // Schedule intermediate Ollama analysis cycle for all theaters (default 30 min)
  const ollamaIntervalMs = config.OLLAMA_ANALYSIS_INTERVAL_MIN * 60 * 1000;
  // Offset the first Ollama run by half the interval so it doesn't overlap with the main cycle
  setTimeout(() => {
    runAllTheaterOllamaCycles(events);
    setInterval(() => runAllTheaterOllamaCycles(events), ollamaIntervalMs);
  }, ollamaIntervalMs / 2);
  console.log(`[star-merlion] Ollama intermediate analysis interval: ${config.OLLAMA_ANALYSIS_INTERVAL_MIN} min (all theaters)`);

  // Seed in-memory dedup cache from DB to prevent alert flood after restart
  for (const key of Object.keys(theaters)) {
    try { seedDedupCache(getDb(key)); } catch (err) {
      console.error(`[star-merlion] Failed to seed dedup cache for ${key}:`, err.message);
    }
  }

  // Run pre-AI anomaly detection every 60 seconds (all theaters)
  runAnomalyCycleAllTheaters(events);
  setInterval(() => runAnomalyCycleAllTheaters(events), 60 * 1000);

  // Broadcast fresh data to WebSocket clients every 30 seconds
  setInterval(() => broadcastSnapshot(events), 30 * 1000);

  // Purge old data every 6 hours (all theaters)
  setInterval(() => {
    for (const key of Object.keys(theaters)) {
      try {
        const result = purge72h(key);
        console.log('[purge:%s] Cleaned old records:', key, result);
      } catch (err) {
        console.error('[purge:%s] Error:', key, err.message);
      }
    }
  }, 6 * 60 * 60 * 1000);

  // Start periodic summary jobs (daily consolidation, weekly summary)
  scheduler.start();

  // Start alert escalation timer (checks every 2 min)
  startEscalationTimer(events);

  // Cross-theater correlation check every 30 min
  setTimeout(() => {
    runCrossTheaterCheck(events);
    setInterval(() => runCrossTheaterCheck(events), 30 * 60 * 1000);
  }, 60 * 1000); // Offset by 1 min to let DBs initialise
  console.log('[star-merlion] Cross-theater correlation interval: 30 min');

  console.log('[star-merlion] All systems started');
}

boot().catch((err) => {
  console.error('[star-merlion] Boot failed:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Shared queries — latest position per entity (deduped by MMSI / callsign)
// ---------------------------------------------------------------------------

function queryLatestVessels(db) {
  let rows = db.prepare(
    `SELECT v.* FROM vessels v
     INNER JOIN (
       SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
       WHERE recorded_at >= datetime('now', '-5 minutes') GROUP BY mmsi
     ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
     ORDER BY v.recorded_at DESC`
  ).all();
  if (rows.length === 0) {
    rows = db.prepare(
      `SELECT v.* FROM vessels v
       INNER JOIN (
         SELECT mmsi, MAX(recorded_at) AS max_ts FROM vessels
         WHERE recorded_at >= datetime('now', '-72 hours') GROUP BY mmsi
       ) latest ON v.mmsi = latest.mmsi AND v.recorded_at = latest.max_ts
       ORDER BY v.recorded_at DESC LIMIT 500`
    ).all();
  }
  return rows;
}

function queryLatestFlights(db) {
  let rows = db.prepare(
    `SELECT f.* FROM flights f
     INNER JOIN (
       SELECT callsign, MAX(recorded_at) AS max_ts FROM flights
       WHERE recorded_at >= datetime('now', '-60 seconds') GROUP BY callsign
     ) latest ON f.callsign = latest.callsign AND f.recorded_at = latest.max_ts
     ORDER BY f.recorded_at DESC`
  ).all();
  if (rows.length === 0) {
    rows = db.prepare(
      `SELECT f.* FROM flights f
       INNER JOIN (
         SELECT callsign, MAX(recorded_at) AS max_ts FROM flights
         WHERE callsign IS NOT NULL
           AND recorded_at >= datetime('now', '-72 hours') GROUP BY callsign
       ) latest ON f.callsign = latest.callsign AND f.recorded_at = latest.max_ts
       ORDER BY f.recorded_at DESC LIMIT 200`
    ).all();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Send initial data snapshot to a newly connected WebSocket client
// ---------------------------------------------------------------------------

function sendInitialSnapshot(client) {
  try {
    const db = getDb();
    const ts = new Date().toISOString();

    const vessels = normalizeTimestampsArray(queryLatestVessels(db));
    const flights = normalizeTimestampsArray(queryLatestFlights(db));
    const weather = normalizeTimestamps(db.prepare('SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1').get()) || null;
    const analysisRow = normalizeTimestamps(db.prepare('SELECT * FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1').get()) || null;

    const send = (type, data) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type, data, timestamp: ts }));
      }
    };

    send('vessels', vessels);
    send('flights', flights);
    if (weather) send('weather', weather);
    if (analysisRow) {
      try {
        const parsed = JSON.parse(analysisRow.threat_json);
        parsed.recorded_at = analysisRow.recorded_at;
        send('analysis', parsed);
      } catch (_) {}
    }

    // OSINT intel articles
    try {
      const intelArticles = db.prepare(
        `SELECT * FROM intel_articles
         WHERE relevance_score >= 20
           AND created_at >= datetime('now', '-24 hours')
         ORDER BY relevance_score DESC, created_at DESC
         LIMIT 20`
      ).all();
      if (intelArticles.length > 0) send('intel', normalizeTimestampsArray(intelArticles));
    } catch (_) { /* table may not exist yet */ }
  } catch (err) {
    console.error('[ws-snapshot] Error sending initial data:', err.message);
  }
}

// ---------------------------------------------------------------------------
// AI analysis cycle (single theater)
// ---------------------------------------------------------------------------

async function runAnalysisCycle(events, theaterKey) {
  try {
    const db = getDb(theaterKey);
    const snapshot = ai.buildSnapshot(db);
    const vaultContext = vault.getVaultContext();

    const result = await ai.analyzeForTheater(snapshot, vaultContext, theaterKey);

    // Store in DB
    db.prepare(
      'INSERT INTO ai_analyses (composite_score, threat_json, tactical_brief) VALUES (?, ?, ?)'
    ).run(
      result.composite_score,
      JSON.stringify(result),
      result.tactical_brief
    );

    // Write to vault
    vault.writeAnalysis(result);

    // Broadcast analysis to WS clients (include timestamp for freshness display)
    result.recorded_at = new Date().toISOString();
    result.theater = theaterKey;
    events.emit('analysis', result);

    // Emit any alerts
    if (result.alerts && result.alerts.length > 0) {
      for (const alert of result.alerts) {
        db.prepare(
          'INSERT INTO alerts (severity, title, description) VALUES (?, ?, ?)'
        ).run(alert.severity, alert.title, alert.description);
        events.emit('alert', alert);
      }
    }

    console.log(`[analysis:${theaterKey}] Score: ${result.composite_score} | Level: ${result.threat_level}`);
  } catch (err) {
    console.error(`[analysis:${theaterKey}] Cycle failed:`, err.message);
  }
}

/**
 * Run AI analysis for all configured theaters.
 */
async function runAllTheaterAnalysisCycles(events) {
  for (const key of Object.keys(theaters)) {
    await runAnalysisCycle(events, key);
  }
}

// ---------------------------------------------------------------------------
// Intermediate Ollama analysis cycle (single theater)
// ---------------------------------------------------------------------------

async function runOllamaIntermediateCycle(events, theaterKey) {
  try {
    const db = getDb(theaterKey);
    const condensedSnapshot = ai.buildCondensedSnapshot(db);

    console.log('[ollama-intermediate:%s] Running condensed analysis (%d vessels, %d anomalies)',
      theaterKey, condensedSnapshot.vessel_count, condensedSnapshot.anomaly_vessels.length);

    const result = await ai.runOllamaForTheater(condensedSnapshot, theaterKey);

    // Store in DB (same table as main analyses)
    db.prepare(
      'INSERT INTO ai_analyses (composite_score, threat_json, tactical_brief) VALUES (?, ?, ?)'
    ).run(
      result.composite_score,
      JSON.stringify(result),
      result.tactical_brief
    );

    // Broadcast to WS clients
    result.recorded_at = new Date().toISOString();
    result.theater = theaterKey;
    events.emit('analysis', result);

    // Emit any alerts
    if (result.alerts && result.alerts.length > 0) {
      for (const alert of result.alerts) {
        db.prepare(
          'INSERT INTO alerts (severity, title, description) VALUES (?, ?, ?)'
        ).run(alert.severity, alert.title, alert.description);
        events.emit('alert', alert);
      }
    }

    console.log('[ollama-intermediate:%s] Score: %d | Level: %s', theaterKey, result.composite_score, result.threat_level);
  } catch (err) {
    // Ollama failures are non-critical — just log and skip
    console.warn('[ollama-intermediate:%s] Cycle failed (non-critical): %s', theaterKey, err.message);
  }
}

/**
 * Run intermediate Ollama analysis for all configured theaters.
 */
async function runAllTheaterOllamaCycles(events) {
  for (const key of Object.keys(theaters)) {
    await runOllamaIntermediateCycle(events, key);
  }
}

// ---------------------------------------------------------------------------
// Pre-AI anomaly detection cycle (single theater)
// ---------------------------------------------------------------------------

function runAnomalyCycleSingle(events, theaterKey) {
  try {
    const db = getDb(theaterKey);
    const vesselCount = db.prepare(
      "SELECT COUNT(DISTINCT mmsi) AS cnt FROM vessels WHERE recorded_at >= datetime('now', '-60 minutes')"
    ).get().cnt;

    const anomalies = runAnomalyChecks(db, theaterKey);

    console.log(`[anomaly:${theaterKey}] Checked: ${vesselCount} vessels, ${anomalies.length} anomalies detected`);

    // Broadcast any new alerts to WS clients — fetch full alert from DB for proper title
    for (const a of anomalies) {
      if (a.alert_id) {
        try {
          const alertRow = db.prepare('SELECT * FROM alerts WHERE id = ?').get(a.alert_id);
          if (alertRow) {
            events.emit('alert', normalizeTimestamps(alertRow));
          }
        } catch (_) {
          // Fallback to basic emit
          events.emit('alert', { severity: 'MEDIUM', title: a.type, mmsi: a.mmsi });
        }
      }
    }
  } catch (err) {
    console.error(`[anomaly:${theaterKey}] Cycle failed:`, err.message);
  }
}

/**
 * Run anomaly checks for all configured theaters.
 */
function runAnomalyCycleAllTheaters(events) {
  for (const key of Object.keys(theaters)) {
    runAnomalyCycleSingle(events, key);
  }
}

// ---------------------------------------------------------------------------
// Snapshot broadcast
// ---------------------------------------------------------------------------

function broadcastSnapshot(events) {
  try {
    const db = getDb();

    const vessels = normalizeTimestampsArray(queryLatestVessels(db));
    const flights = normalizeTimestampsArray(queryLatestFlights(db));

    const weather = normalizeTimestamps(db.prepare(
      'SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1'
    ).get()) || null;

    const analysis = normalizeTimestamps(db.prepare(
      'SELECT * FROM ai_analyses ORDER BY recorded_at DESC LIMIT 1'
    ).get()) || null;

    // Always broadcast so frontend has accurate state
    events.emit('vessels', vessels);
    events.emit('flights', flights);
    if (weather) {
      events.emit('weather', weather);
    }
    if (analysis) {
      try {
        const parsed = JSON.parse(analysis.threat_json);
        parsed.recorded_at = analysis.recorded_at;
        events.emit('analysis', parsed);
      } catch (_) { /* malformed json, skip */ }
    }

    // OSINT intel articles
    try {
      const intelArticles = db.prepare(
        `SELECT * FROM intel_articles
         WHERE relevance_score >= 20
           AND created_at >= datetime('now', '-24 hours')
         ORDER BY relevance_score DESC, created_at DESC
         LIMIT 20`
      ).all();
      if (intelArticles.length > 0) {
        events.emit('intel', normalizeTimestampsArray(intelArticles));
      }
    } catch (_) { /* table may not exist yet */ }
  } catch (err) {
    console.error('[broadcast] Error:', err.message);
  }
}
