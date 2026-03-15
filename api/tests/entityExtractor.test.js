'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractEntities, scoreRelevance } = require('../src/services/entityExtractor');

// ---------------------------------------------------------------------------
// extractEntities
// ---------------------------------------------------------------------------
describe('extractEntities', () => {
  it('finds MMSI (9-digit number starting with 2-7) in text', () => {
    const result = extractEntities('vessel MMSI 353456789 was observed near the strait');
    assert.ok(result.mmsis.includes('353456789'), 'Should extract MMSI 353456789');
  });

  it('finds IMO numbers matching pattern "IMO 1234567"', () => {
    const result = extractEntities('The vessel IMO 9876543 was flagged for inspection');
    assert.ok(result.imos.length > 0, 'Should find at least one IMO number');
    assert.ok(
      result.imos.some((imo) => imo.includes('9876543')),
      'Should extract IMO 9876543'
    );
  });

  it('finds Singapore Strait locations', () => {
    const result = extractEntities(
      'Piracy incident reported in Philip Channel near Singapore Strait, vessel heading toward Batam via TSS'
    );
    assert.ok(result.locations.includes('Philip Channel'), 'Should find Philip Channel');
    assert.ok(result.locations.includes('Singapore Strait'), 'Should find Singapore Strait');
    assert.ok(result.locations.includes('Batam'), 'Should find Batam');
    assert.ok(result.locations.includes('TSS'), 'Should find TSS');
  });

  it('returns empty arrays for text with no maritime entities', () => {
    const result = extractEntities('The weather today is sunny with clear skies.');
    assert.equal(result.mmsis.length, 0);
    assert.equal(result.imos.length, 0);
    assert.equal(result.vesselNames.length, 0);
    assert.equal(result.locations.length, 0);
  });

  it('does NOT match 9-digit numbers starting with 0, 1, 8, or 9 as MMSIs', () => {
    const result = extractEntities(
      'Phone numbers: 012345678, 198765432, 812345678, 987654321 are not vessels'
    );
    assert.equal(result.mmsis.length, 0, 'Should not match invalid MMSI prefixes');
  });
});

// ---------------------------------------------------------------------------
// scoreRelevance
// ---------------------------------------------------------------------------
describe('scoreRelevance', () => {
  it('returns high score (>= 60) for recent piracy article in Singapore Strait with MMSI', () => {
    const article = {
      title: 'Piracy alert in Singapore Strait',
      body: 'Vessel MMSI 353456789 reported suspicious activity near Philip Channel',
      published_at: new Date().toISOString(),
    };
    const entities = extractEntities(`${article.title} ${article.body}`);
    const score = scoreRelevance(article, entities);
    assert.ok(score >= 60, `Score should be >= 60 but got ${score}`);
  });

  it('returns low score (< 30) for old article about shipbuilding in Korea with no entities', () => {
    const article = {
      title: 'New shipbuilding yard opens in Busan',
      body: 'Hyundai Heavy Industries announced a new facility for LNG carrier construction in South Korea.',
      published_at: '2020-01-01T00:00:00Z',
    };
    const entities = extractEntities(`${article.title} ${article.body}`);
    const score = scoreRelevance(article, entities);
    assert.ok(score < 30, `Score should be < 30 but got ${score}`);
  });

  it('awards geographic bonus (+30) when Singapore Strait location is found', () => {
    const articleNoLocation = {
      title: 'General maritime news',
      body: 'A vessel was seen.',
    };
    const entitiesNoLoc = { mmsis: [], imos: [], vesselNames: [], locations: [] };
    const scoreNoLoc = scoreRelevance(articleNoLocation, entitiesNoLoc);

    const articleWithLocation = {
      title: 'General maritime news',
      body: 'A vessel was seen.',
    };
    const entitiesWithLoc = { mmsis: [], imos: [], vesselNames: [], locations: ['Singapore Strait'] };
    const scoreWithLoc = scoreRelevance(articleWithLocation, entitiesWithLoc);

    assert.equal(scoreWithLoc - scoreNoLoc, 30, 'Geographic bonus should be +30');
  });

  it('awards recency bonus (+20) for article published within 24 hours', () => {
    const baseEntities = { mmsis: [], imos: [], vesselNames: [], locations: [] };

    const recentArticle = {
      title: 'Breaking news',
      body: 'Something happened.',
      published_at: new Date().toISOString(),
    };
    const scoreRecent = scoreRelevance(recentArticle, baseEntities);

    const oldArticle = {
      title: 'Breaking news',
      body: 'Something happened.',
      published_at: '2020-01-01T00:00:00Z',
    };
    const scoreOld = scoreRelevance(oldArticle, baseEntities);

    assert.equal(scoreRecent - scoreOld, 20, 'Recency bonus should be +20 for articles within 24 hours');
  });

  it('caps at 100', () => {
    const article = {
      title: 'Piracy hijack suspicious smuggling illegal collision grounding distress attack in Singapore Strait',
      body: 'Vessel MMSI 353456789, IMO 9876543, MV Star Voyager spotted near Philip Channel, Batam, TSS',
      published_at: new Date().toISOString(),
    };
    const entities = extractEntities(`${article.title} ${article.body}`);
    const score = scoreRelevance(article, entities);
    assert.ok(score <= 100, `Score should not exceed 100 but got ${score}`);
  });
});
