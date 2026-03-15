'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getDb, close } = require('../src/db');

const { startEscalationTimer } = require('../src/services/escalation');

let db;

before(() => {
  close();
  db = getDb(':memory:');
});

after(() => {
  close();
});

// ---------------------------------------------------------------------------
// Escalation rules
// ---------------------------------------------------------------------------
describe('Escalation service', () => {
  it('escalates MEDIUM to HIGH after 30 minutes', () => {
    // Insert a MEDIUM alert created 35 minutes ago
    db.prepare(
      "INSERT INTO alerts (severity, title, description, entity_mmsi, acknowledged, created_at) VALUES (?, ?, ?, ?, 0, datetime('now', '-35 minutes'))"
    ).run('MEDIUM', 'Old medium alert', 'Test', 'ESC000001');

    const events = new EventEmitter();
    const emitted = [];
    events.on('alert', (a) => emitted.push(a));

    const timer = startEscalationTimer(events);
    clearInterval(timer);

    // Verify the DB was updated: original alert should now be HIGH
    const row = db.prepare('SELECT severity FROM alerts WHERE entity_mmsi = ?').get('ESC000001');
    assert.equal(row.severity, 'HIGH');

    // Should have emitted an escalation alert
    assert.ok(emitted.length > 0, 'Should emit an escalation alert');
    assert.equal(emitted[0].severity, 'HIGH');
    assert.ok(emitted[0].title, 'Escalation alert should have a title');
  });

  it('escalates HIGH to CRITICAL after 15 minutes', () => {
    // Insert a HIGH alert created 20 minutes ago
    db.prepare(
      "INSERT INTO alerts (severity, title, description, entity_mmsi, acknowledged, created_at) VALUES (?, ?, ?, ?, 0, datetime('now', '-20 minutes'))"
    ).run('HIGH', 'Old high alert', 'Test', 'ESC000002');

    const events = new EventEmitter();
    const emitted = [];
    events.on('alert', (a) => emitted.push(a));

    const timer = startEscalationTimer(events);
    clearInterval(timer);

    // Verify the DB was updated
    const row = db.prepare('SELECT severity FROM alerts WHERE entity_mmsi = ?').get('ESC000002');
    assert.equal(row.severity, 'CRITICAL');
  });

  it('does NOT escalate acknowledged alerts', () => {
    // Insert an acknowledged MEDIUM alert older than 30 minutes
    db.prepare(
      "INSERT INTO alerts (severity, title, description, entity_mmsi, acknowledged, status, created_at) VALUES (?, ?, ?, ?, 1, 'ACKNOWLEDGED', datetime('now', '-60 minutes'))"
    ).run('MEDIUM', 'Acked medium', 'Test', 'ESC000003');

    const events = new EventEmitter();
    const emitted = [];
    events.on('alert', (a) => emitted.push(a));

    const timer = startEscalationTimer(events);
    clearInterval(timer);

    // Verify the DB still shows MEDIUM
    const row = db.prepare('SELECT severity FROM alerts WHERE entity_mmsi = ?').get('ESC000003');
    assert.equal(row.severity, 'MEDIUM');
  });

  it('does NOT escalate recent MEDIUM alerts (under 30 min)', () => {
    // Insert a MEDIUM alert created 10 minutes ago
    db.prepare(
      "INSERT INTO alerts (severity, title, description, entity_mmsi, acknowledged, created_at) VALUES (?, ?, ?, ?, 0, datetime('now', '-10 minutes'))"
    ).run('MEDIUM', 'Recent medium', 'Test', 'ESC000005');

    const events = new EventEmitter();
    const emitted = [];
    events.on('alert', (a) => emitted.push(a));

    const timer = startEscalationTimer(events);
    clearInterval(timer);

    const row = db.prepare('SELECT severity FROM alerts WHERE entity_mmsi = ?').get('ESC000005');
    assert.equal(row.severity, 'MEDIUM');
  });
});
