'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../src/scheduler');

describe('scheduler module exports', () => {
  it('exports start function', () => {
    assert.strictEqual(typeof scheduler.start, 'function');
  });

  it('exports stop function', () => {
    assert.strictEqual(typeof scheduler.stop, 'function');
  });

  it('exports getScheduleStatus function', () => {
    assert.strictEqual(typeof scheduler.getScheduleStatus, 'function');
  });
});

describe('getScheduleStatus', () => {
  it('returns an object with running and jobs', () => {
    const status = scheduler.getScheduleStatus();

    assert.strictEqual(typeof status, 'object');
    assert.strictEqual(typeof status.running, 'boolean');
    assert.strictEqual(typeof status.jobs, 'object');
  });

  it('reports running as false before start is called', () => {
    const status = scheduler.getScheduleStatus();
    assert.strictEqual(status.running, false);
  });
});
