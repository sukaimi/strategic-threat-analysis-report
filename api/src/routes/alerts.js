'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { validate } = require('../middleware/validate');
const { normalizeTimestampsArray } = require('../utils/normalizeTimestamps');

const router = Router();

const validateAlert = validate({
  severity:    { required: true, type: 'string', oneOf: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
  title:       { required: true, type: 'string', maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
});

// GET /api/alerts — alerts with optional status and category filters
router.get('/', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { status, category } = req.query;

    let sql = 'SELECT * FROM alerts WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    } else {
      // Default: show unacknowledged (backward compat)
      sql += " AND (status = 'NEW' OR (status IS NULL AND acknowledged = 0))";
    }

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = db.prepare(sql).all(...params);
    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/alerts/all — alerts from the last 72 hours
router.get('/all', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const rows = db.prepare(
      "SELECT * FROM alerts WHERE created_at >= datetime('now', '-72 hours') ORDER BY created_at DESC LIMIT 1000"
    ).all();
    res.json(normalizeTimestampsArray(rows));
  } catch (err) {
    next(err);
  }
});

// POST /api/alerts — insert an alert
router.post('/', validateAlert, (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { severity, title, description, entity_mmsi, entity_callsign, flagged, category } = req.body;
    const info = db.prepare(
      'INSERT INTO alerts (severity, title, description, entity_mmsi, entity_callsign, flagged, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(severity, title ?? null, description ?? null, entity_mmsi ?? null, entity_callsign ?? null, flagged ?? 0, category ?? null);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alerts/:id/status — update alert status, assigned_to, resolution_notes
router.patch('/:id/status', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const { status, assigned_to, resolution_notes } = req.body;

    const validStatuses = ['NEW', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const updates = ['status = ?'];
    const params = [status];

    // Also set acknowledged flag for backward compat
    if (status !== 'NEW') {
      updates.push('acknowledged = 1');
    }

    if (assigned_to !== undefined) {
      updates.push('assigned_to = ?');
      params.push(assigned_to);
    }

    if (resolution_notes !== undefined) {
      updates.push('resolution_notes = ?');
      params.push(resolution_notes);
    }

    if (status === 'RESOLVED') {
      updates.push("resolved_at = datetime('now')");
    }

    params.push(req.params.id);
    const sql = `UPDATE alerts SET ${updates.join(', ')} WHERE id = ?`;
    const info = db.prepare(sql).run(...params);

    if (info.changes === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ updated: true, status });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/alerts/:id/acknowledge — backward-compatible acknowledge route
router.patch('/:id/acknowledge', (req, res, next) => {
  try {
    const db = req.theaterDb || getDb();
    const info = db.prepare(
      "UPDATE alerts SET acknowledged = 1, status = 'ACKNOWLEDGED' WHERE id = ?"
    ).run(req.params.id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json({ acknowledged: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
