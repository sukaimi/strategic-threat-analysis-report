'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseName,
  levenshtein,
  fuzzyMatchName,
  flagRisk,
  screenVessel,
  screenBatch,
  refreshFromUrl,
  getStats,
  HIGH_RISK_FLAGS,
  load,
} = require('../src/services/sanctions');

// ---------------------------------------------------------------------------
// levenshtein distance
// ---------------------------------------------------------------------------
describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('HELLO', 'HELLO'), 0);
  });

  it('returns correct distance for single edit', () => {
    assert.equal(levenshtein('KITTEN', 'SITTEN'), 1);
  });

  it('handles empty strings', () => {
    assert.equal(levenshtein('', 'ABC'), 3);
    assert.equal(levenshtein('ABC', ''), 3);
    assert.equal(levenshtein('', ''), 0);
  });

  it('calculates multi-edit distance', () => {
    assert.equal(levenshtein('SITTING', 'KITTEN'), 3);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatchName
// ---------------------------------------------------------------------------
describe('fuzzyMatchName', () => {
  it('matches exact name', () => {
    const result = fuzzyMatchName('WISE HONEST');
    assert.ok(result, 'Should match WISE HONEST');
    assert.equal(result.vessel_name, 'WISE HONEST');
  });

  it('matches close misspelling', () => {
    // "WIZE HONEST" is 1 edit from "WISE HONEST"
    const result = fuzzyMatchName('WIZE HONEST');
    assert.ok(result, 'Should fuzzy match WIZE HONEST');
    assert.equal(result.vessel_name, 'WISE HONEST');
  });

  it('returns null for very different name', () => {
    const result = fuzzyMatchName('COMPLETELY DIFFERENT VESSEL');
    assert.equal(result, null);
  });

  it('returns null for short strings', () => {
    assert.equal(fuzzyMatchName('AB'), null);
    assert.equal(fuzzyMatchName(''), null);
    assert.equal(fuzzyMatchName(null), null);
  });
});

// ---------------------------------------------------------------------------
// flagRisk
// ---------------------------------------------------------------------------
describe('flagRisk', () => {
  it('flags Panama as high risk', () => {
    assert.equal(flagRisk('PA').risk, 'high');
  });

  it('flags Liberia as high risk', () => {
    assert.equal(flagRisk('LR').risk, 'high');
  });

  it('flags Marshall Islands as high risk', () => {
    assert.equal(flagRisk('MH').risk, 'high');
  });

  it('flags Cameroon as high risk', () => {
    assert.equal(flagRisk('CM').risk, 'high');
  });

  it('flags Tanzania as high risk', () => {
    assert.equal(flagRisk('TZ').risk, 'high');
  });

  it('flags Comoros as high risk', () => {
    assert.equal(flagRisk('KM').risk, 'high');
  });

  it('returns normal for Singapore', () => {
    assert.equal(flagRisk('SG').risk, 'normal');
  });

  it('handles null/undefined', () => {
    assert.equal(flagRisk(null).risk, 'normal');
    assert.equal(flagRisk(undefined).risk, 'normal');
  });
});

// ---------------------------------------------------------------------------
// screenVessel with fuzzy matching
// ---------------------------------------------------------------------------
describe('screenVessel — fuzzy & flag risk', () => {
  it('returns flag_risk in result', () => {
    const result = screenVessel({ mmsi: '999999', flag_state: 'PA' });
    assert.ok(result.flag_risk);
    assert.equal(result.flag_risk.risk, 'high');
  });

  it('fuzzy matches vessel name', () => {
    const result = screenVessel({ vessel_name: 'ADRIEN DARYA 1' }); // misspelling
    assert.ok(result.matched, 'Should fuzzy-match ADRIAN DARYA 1');
    assert.equal(result.hits[0].match_type, 'fuzzy');
  });
});

// ---------------------------------------------------------------------------
// refreshFromUrl stub
// ---------------------------------------------------------------------------
describe('refreshFromUrl', () => {
  it('returns a stub response', async () => {
    const result = await refreshFromUrl('https://example.com/sanctions.json');
    assert.equal(result.refreshed, false);
    assert.ok(result.message.includes('stub'));
  });
});

// ---------------------------------------------------------------------------
// Seed data count
// ---------------------------------------------------------------------------
describe('sanctions seed data', () => {
  it('has 50+ entities loaded', () => {
    const stats = getStats();
    assert.ok(stats.entityCount >= 50, `Expected 50+ entities, got ${stats.entityCount}`);
  });
});
