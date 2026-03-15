'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const schedule = require('node-schedule');
const db = require('../../api/src/db');

// Services — loaded defensively since they may not exist yet
let ai = null;
let vault = null;
try { ai = require('../../api/src/services/ai'); } catch (_e) { /* not yet implemented */ }
try { vault = require('../../api/src/services/vault'); } catch (_e) { /* not yet implemented */ }

const jobs = {};
let running = false;

// NOTE: Collectors, AI analysis cycles, data purge, and WS broadcasts are
// all owned by api/src/server.js.  This scheduler only handles periodic
// summary jobs (daily consolidation, weekly summary) that do NOT need to
// run every few minutes.

// ---------------------------------------------------------------------------
// Job: Memory Consolidation — daily at 02:00 SGT (18:00 UTC previous day)
// ---------------------------------------------------------------------------
function scheduleMemoryConsolidation() {
  jobs.memoryConsolidation = schedule.scheduleJob('0 18 * * *', async () => {
    try {
      if (!ai || !vault) {
        console.log('[scheduler] memory-consolidation — skipped (services not available)');
        return;
      }

      const sqliteDb = db.getDb();

      // Read all analyses from today
      const analyses = sqliteDb.prepare(
        `SELECT * FROM ai_analyses
         WHERE recorded_at >= datetime('now', 'start of day')
         ORDER BY recorded_at ASC`
      ).all();

      if (analyses.length === 0) {
        console.log('[scheduler] memory-consolidation — no analyses today, skipping');
        return;
      }

      // Summarise into daily summary via AI
      const dailySummary = await ai.analyze(
        { type: 'daily_summary', analyses },
        { instruction: 'Summarise the following analyses into a concise daily summary.' }
      );

      // Write daily summary to vault
      await vault.writeDailySummary(dailySummary);

      console.log('[scheduler] memory-consolidation — completed (%d analyses consolidated)', analyses.length);
    } catch (err) {
      console.error('[scheduler] memory-consolidation — error: %s', err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Job: Weekly Summary — Sunday 00:00 SGT (16:00 UTC Saturday)
// ---------------------------------------------------------------------------
function scheduleWeeklySummary() {
  jobs.weeklySummary = schedule.scheduleJob('0 16 * * 0', async () => {
    try {
      if (!ai || !vault) {
        console.log('[scheduler] weekly-summary — skipped (services not available)');
        return;
      }

      const sqliteDb = db.getDb();

      // Read daily summaries (analyses) from last 7 days
      const weeklySummaries = sqliteDb.prepare(
        `SELECT * FROM ai_analyses
         WHERE recorded_at >= datetime('now', '-7 days')
         ORDER BY recorded_at ASC`
      ).all();

      if (weeklySummaries.length === 0) {
        console.log('[scheduler] weekly-summary — no data for the past week, skipping');
        return;
      }

      // Create weekly pattern summary via AI
      const weeklyReport = await ai.analyze(
        { type: 'weekly_summary', analyses: weeklySummaries },
        { instruction: 'Create a weekly pattern summary from the following daily analyses.' }
      );

      // Write to vault
      await vault.writeWeeklySummary(weeklyReport);

      console.log('[scheduler] weekly-summary — completed (%d records analysed)', weeklySummaries.length);
    } catch (err) {
      console.error('[scheduler] weekly-summary — error: %s', err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start periodic summary jobs (daily consolidation, weekly summary).
 */
function start() {
  if (running) {
    console.log('[scheduler] already running');
    return;
  }

  running = true;

  // Only schedule periodic summary jobs — collectors, AI analysis, purge,
  // and broadcasts are handled by api/src/server.js.
  scheduleMemoryConsolidation();
  scheduleWeeklySummary();

  // Log next run times
  for (const [name, job] of Object.entries(jobs)) {
    const next = job && job.nextInvocation ? job.nextInvocation() : null;
    console.log('[scheduler] %s — next run: %s', name, next ? next.toISOString() : 'N/A');
  }

  console.log('[scheduler] started — %d jobs scheduled', Object.keys(jobs).length);

  // NOTE: Signal handlers and db.close() are owned by the host process
  // (api/src/server.js). The scheduler only cancels its own jobs on stop().
}

/**
 * Cancel every scheduled job and close the database.
 */
function stop() {
  for (const [name, job] of Object.entries(jobs)) {
    if (job) {
      job.cancel();
      console.log('[scheduler] %s — cancelled', name);
    }
    delete jobs[name];
  }

  // NOTE: db.close() is NOT called here — the scheduler runs inside the API
  // process, which owns the DB lifecycle.
  running = false;
  console.log('[scheduler] stopped');
}

/**
 * Return the status of every scheduled job.
 * @returns {object} keyed by job name
 */
function getScheduleStatus() {
  const status = {};
  for (const [name, job] of Object.entries(jobs)) {
    const next = job && job.nextInvocation ? job.nextInvocation() : null;
    status[name] = {
      scheduled: !!job,
      nextRun: next ? next.toISOString() : null,
    };
  }
  return {
    running,
    jobs: status,
  };
}

module.exports = { start, stop, getScheduleStatus };
