'use strict';

const { getDb } = require('../db');

// Track which alert IDs have already been escalated to avoid re-escalating
// Map<alertId, timestampMs> — pruned periodically to prevent unbounded growth
const escalatedIds = new Map();

// Escalation rules: severity → { thresholdMinutes, newSeverity (null for CRITICAL) }
const ESCALATION_RULES = {
  CRITICAL: { thresholdMinutes: 5, newSeverity: null },      // already max — just warn
  HIGH:     { thresholdMinutes: 15, newSeverity: 'CRITICAL' },
  MEDIUM:   { thresholdMinutes: 30, newSeverity: 'HIGH' },
};

const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Check for unacknowledged alerts that exceed their escalation threshold.
 * Escalation ONLY updates severity on the original row — never creates new rows.
 *
 * @param {import('node:events').EventEmitter} events
 */
function runEscalationCheck(events) {
  try {
    // Prune escalation tracking older than 2 hours to prevent memory leak
    const pruneCutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, ts] of escalatedIds) {
      if (ts < pruneCutoff) escalatedIds.delete(id);
    }

    const db = getDb();

    for (const [severity, rule] of Object.entries(ESCALATION_RULES)) {
      const rows = db.prepare(
        `SELECT id, title, created_at FROM alerts
         WHERE severity = ?
           AND acknowledged = 0
           AND created_at <= datetime('now', ? || ' minutes')
         ORDER BY created_at ASC
         LIMIT 100`
      ).all(severity, String(-rule.thresholdMinutes));

      for (const alert of rows) {
        if (escalatedIds.has(alert.id)) continue;

        const createdMs = new Date(alert.created_at + 'Z').getTime();
        const elapsedMinutes = Math.round((Date.now() - createdMs) / 60000);

        if (severity === 'CRITICAL') {
          // Already maximum severity — log only, no DB changes
          console.warn(
            `[escalation] CRITICAL alert #${alert.id} unacknowledged for ${elapsedMinutes} min: ${alert.title}`
          );
        } else {
          // Escalate: update severity on the ORIGINAL row (no new row)
          const newSeverity = rule.newSeverity;
          db.prepare('UPDATE alerts SET severity = ? WHERE id = ?').run(newSeverity, alert.id);

          console.warn(
            `[escalation] Alert #${alert.id} ${severity} → ${newSeverity} (${elapsedMinutes} min): ${alert.title}`
          );

          events.emit('alert', {
            severity: newSeverity,
            title: alert.title,
            description: `Escalated from ${severity} after ${elapsedMinutes} min unacknowledged`,
          });
        }

        escalatedIds.set(alert.id, Date.now());
      }
    }
  } catch (err) {
    console.error('[escalation] Check failed:', err.message);
  }
}

/**
 * Start the periodic escalation timer.
 *
 * @param {import('node:events').EventEmitter} events — the shared event bus
 * @returns {NodeJS.Timeout} interval handle (for cleanup / testing)
 */
function startEscalationTimer(events) {
  console.log('[escalation] Starting escalation timer (every 2 min)');

  // Run an initial check immediately
  runEscalationCheck(events);

  return setInterval(() => runEscalationCheck(events), INTERVAL_MS);
}

module.exports = { startEscalationTimer };
