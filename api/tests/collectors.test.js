'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

describe('Collectors index module', () => {
  let collectorsIndex;

  before(() => {
    // Ensure DB singleton is initialised with in-memory DB before loading collectors
    getDb(':memory:');
    collectorsIndex = require('../src/collectors/index');
  });

  after(() => {
    // Stop any running collectors to clean up timers
    collectorsIndex.stopAll();
    close();
  });

  it('exports startAll, stopAll, getStatus', () => {
    assert.equal(typeof collectorsIndex.startAll, 'function', 'should export startAll');
    assert.equal(typeof collectorsIndex.stopAll, 'function', 'should export stopAll');
    assert.equal(typeof collectorsIndex.getStatus, 'function', 'should export getStatus');
  });

  it('getStatus returns status for all 11 collectors', () => {
    const status = collectorsIndex.getStatus();
    const keys = Object.keys(status);

    assert.ok(keys.includes('ais'), 'status should include ais');
    assert.ok(keys.includes('mpa'), 'status should include mpa');
    assert.ok(keys.includes('flights'), 'status should include flights');
    assert.ok(keys.includes('weather'), 'status should include weather');
    assert.ok(keys.includes('port'), 'status should include port');
    assert.ok(keys.includes('osint'), 'status should include osint');
    assert.ok(keys.includes('nea'), 'status should include nea');
    assert.ok(keys.includes('ofac'), 'status should include ofac');
    assert.ok(keys.includes('acled'), 'status should include acled');
    assert.ok(keys.includes('gdelt'), 'status should include gdelt');
    assert.ok(keys.includes('firms'), 'status should include firms');
    assert.equal(keys.length, 11, 'should have exactly 11 collector entries');

    // Each collector entry should have a 'status' field
    for (const name of ['mpa', 'ais', 'flights', 'weather', 'port', 'osint', 'nea', 'ofac', 'acled', 'gdelt', 'firms']) {
      assert.equal(typeof status[name].status, 'string', `${name} should have string status field`);
    }
  });
});
