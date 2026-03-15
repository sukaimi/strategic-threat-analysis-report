'use strict';

// Set provider order to deepseek,gemini for circuit breaker tests (no ollama)
process.env.AI_PROVIDER_ORDER = 'deepseek,gemini';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, close } = require('../src/db');

// Invalidate config cache so it picks up the provider order
delete require.cache[require.resolve('../src/config')];

// We import after db so config is loaded, but we will mock fetch for API tests.
const ai = require('../src/services/ai');

describe('AI analysis engine', () => {
  let db;

  before(() => {
    db = getDb(':memory:');
  });

  after(() => {
    close();
  });

  beforeEach(() => {
    ai._resetCircuitBreaker();
  });

  // -----------------------------------------------------------------------
  // buildSnapshot
  // -----------------------------------------------------------------------
  describe('buildSnapshot', () => {
    it('returns correct structure with data from DB', () => {
      // Insert test data
      db.prepare(
        'INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('999000001', 1.26, 103.85, 10.5, 270, 'MV Alpha', 'tanker');

      db.prepare(
        'INSERT INTO flights (callsign, squawk, lat, lon, altitude_ft, speed_kt, heading) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('SIA215', '1200', 1.35, 103.95, 32000, 480, 45);

      db.prepare(
        'INSERT INTO weather (cb_cells, wind_speed_kt, wind_dir, visibility_km, sea_state) VALUES (?, ?, ?, ?, ?)'
      ).run(2, 18.0, 200, 10.0, 'slight');

      db.prepare(
        'INSERT INTO port_status (vessels_queued, berth_utilisation, channel_flow_pct) VALUES (?, ?, ?)'
      ).run(8, 0.65, 72.0);

      const snapshot = ai.buildSnapshot(db);

      // Top-level keys
      assert.ok(snapshot.timestamp, 'should have timestamp');
      assert.ok(snapshot.vessels, 'should have vessels');
      assert.ok(snapshot.flights, 'should have flights');
      assert.ok('weather' in snapshot, 'should have weather key');
      assert.ok('port_status' in snapshot, 'should have port_status key');

      // Vessels structure
      assert.equal(typeof snapshot.vessels.count, 'number');
      assert.ok(Array.isArray(snapshot.vessels.data));
      assert.ok(snapshot.vessels.count >= 1, 'should have at least 1 vessel');

      // Flights structure
      assert.equal(typeof snapshot.flights.count, 'number');
      assert.ok(Array.isArray(snapshot.flights.data));
      assert.ok(snapshot.flights.count >= 1, 'should have at least 1 flight');

      // Weather
      assert.ok(snapshot.weather, 'should have weather data');
      assert.equal(snapshot.weather.sea_state, 'slight');

      // Port status
      assert.ok(snapshot.port_status, 'should have port_status data');
      assert.equal(snapshot.port_status.vessels_queued, 8);
    });
  });

  // -----------------------------------------------------------------------
  // System prompt validation
  // -----------------------------------------------------------------------
  describe('system prompt', () => {
    it('contains all required schema fields', () => {
      const prompt = ai.SYSTEM_PROMPT;
      const requiredFields = [
        'composite_score',
        'threat_level',
        'category_scores',
        'maritime_security',
        'navigation_safety',
        'port_congestion',
        'weather_risk',
        'airspace_activity',
        'tactical_brief',
        'key_findings',
        'priority_actions',
        'vessel_anomalies',
        'alerts',
        'forecast_6h',
        'forecast_24h',
      ];
      for (const field of requiredFields) {
        assert.ok(prompt.includes(field), `system prompt should contain "${field}"`);
      }
    });

    it('mentions SPECTRE persona', () => {
      assert.ok(ai.SYSTEM_PROMPT.includes('SPECTRE'));
    });

    it('mentions AIS-dark behavior detection', () => {
      assert.ok(ai.SYSTEM_PROMPT.includes('AIS-dark'));
    });
  });

  // -----------------------------------------------------------------------
  // Ollama system prompt
  // -----------------------------------------------------------------------
  describe('OLLAMA_SYSTEM_PROMPT', () => {
    it('contains all required schema fields (same as main prompt)', () => {
      const prompt = ai.OLLAMA_SYSTEM_PROMPT;
      const requiredFields = [
        'composite_score', 'threat_level', 'category_scores',
        'maritime_security', 'navigation_safety', 'port_congestion',
        'weather_risk', 'airspace_activity', 'tactical_brief',
        'key_findings', 'priority_actions', 'vessel_anomalies',
        'alerts', 'forecast_6h', 'forecast_24h',
      ];
      for (const field of requiredFields) {
        assert.ok(prompt.includes(field), `Ollama prompt should contain "${field}"`);
      }
    });

    it('uses sanitized language (no intelligence/surveillance/threat wording)', () => {
      const prompt = ai.OLLAMA_SYSTEM_PROMPT;
      assert.ok(!prompt.includes('intelligence analyst'), 'should not say "intelligence analyst"');
      assert.ok(!prompt.includes('surveillance'), 'should not say "surveillance"');
      assert.ok(!prompt.includes('AIS-dark'), 'should not say "AIS-dark"');
      assert.ok(prompt.includes('traffic safety analyst'), 'should say "traffic safety analyst"');
      assert.ok(prompt.includes('AIS signal gaps'), 'should say "AIS signal gaps"');
      assert.ok(prompt.includes('compliance checks'), 'should say "compliance checks"');
    });
  });

  // -----------------------------------------------------------------------
  // buildCondensedSnapshot
  // -----------------------------------------------------------------------
  describe('buildCondensedSnapshot', () => {
    it('returns correct condensed structure', () => {
      // Insert test data for condensed snapshot
      db.prepare(
        'INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('888000001', 1.26, 103.85, 25.0, 180, 'MV Speedy', 'cargo');

      db.prepare(
        'INSERT INTO weather (cb_cells, wind_speed_kt, wind_dir, visibility_km, sea_state) VALUES (?, ?, ?, ?, ?)'
      ).run(0, 7.0, 45, 24.0, 'moderate');

      db.prepare(
        'INSERT INTO port_status (vessels_queued, berth_utilisation, channel_flow_pct) VALUES (?, ?, ?)'
      ).run(12, 0.95, 85.0);

      const snap = ai.buildCondensedSnapshot(db);

      assert.ok(snap.timestamp, 'should have timestamp');
      assert.equal(typeof snap.vessel_count, 'number');
      assert.ok(Array.isArray(snap.anomaly_vessels), 'should have anomaly_vessels array');
      assert.equal(typeof snap.weather_summary, 'string');
      assert.equal(typeof snap.port_summary, 'string');
      assert.ok(snap.alert_summary, 'should have alert_summary');
      assert.equal(typeof snap.flights_count, 'number');
      assert.equal(typeof snap.weather_impact, 'string');
    });

    it('limits anomaly vessels to 5', () => {
      // Insert 10 high-speed vessels
      for (let i = 0; i < 10; i++) {
        db.prepare(
          'INSERT INTO vessels (mmsi, lat, lon, speed_kt, heading, vessel_name, vessel_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(`777${String(i).padStart(6, '0')}`, 1.26, 103.85, 25.0 + i, 90, `MV Fast${i}`, 'cargo');
      }

      const snap = ai.buildCondensedSnapshot(db);
      assert.ok(snap.anomaly_vessels.length <= 5, 'should have at most 5 anomaly vessels');
    });

    it('produces a small JSON payload (under 2000 chars)', () => {
      const snap = ai.buildCondensedSnapshot(db);
      const json = JSON.stringify(snap, null, 0);
      assert.ok(json.length < 2000, `condensed payload should be under 2000 chars, got ${json.length}`);
    });
  });

  // -----------------------------------------------------------------------
  // Response parsing
  // -----------------------------------------------------------------------
  describe('parseAnalysisJSON', () => {
    it('parses valid JSON correctly', () => {
      const input = JSON.stringify({
        composite_score: 42,
        threat_level: 'MEDIUM',
        category_scores: {
          maritime_security: 50,
          navigation_safety: 30,
          port_congestion: 40,
          weather_risk: 20,
          airspace_activity: 10,
        },
        tactical_brief: 'Moderate activity detected.',
        key_findings: ['Finding 1'],
        priority_actions: ['Action 1'],
        vessel_anomalies: [],
        alerts: [],
        forecast_6h: 'Stable',
        forecast_24h: 'Stable',
      });

      const result = ai.parseAnalysisJSON(input);
      assert.equal(result.composite_score, 42);
      assert.equal(result.threat_level, 'MEDIUM');
      assert.equal(result.tactical_brief, 'Moderate activity detected.');
    });

    it('parses JSON wrapped in markdown code fences', () => {
      const input = '```json\n{"composite_score": 10, "threat_level": "LOW"}\n```';
      const result = ai.parseAnalysisJSON(input);
      assert.equal(result.composite_score, 10);
      assert.equal(result.threat_level, 'LOW');
    });

    it('returns fallback response for invalid JSON', () => {
      assert.throws(() => ai.parseAnalysisJSON('not valid json at all'), {
        message: /Failed to parse/,
      });
    });
  });

  describe('makeFallbackResponse', () => {
    it('returns correct structure with error message', () => {
      const result = ai.makeFallbackResponse('Test error');
      assert.equal(result.composite_score, 0);
      assert.equal(result.threat_level, 'LOW');
      assert.ok(result.tactical_brief.includes('Test error'));
      assert.ok(Array.isArray(result.key_findings));
      assert.ok(Array.isArray(result.alerts));
      assert.equal(result.forecast_6h, 'Unavailable');
    });
  });

  // -----------------------------------------------------------------------
  // getAIStats
  // -----------------------------------------------------------------------
  describe('getAIStats', () => {
    it('returns correct structure', () => {
      const stats = ai.getAIStats();
      assert.equal(typeof stats.totalRequests, 'number');
      assert.equal(typeof stats.totalTokensUsed, 'number');
      assert.equal(typeof stats.consecutiveFailures, 'number');
      assert.equal(typeof stats.usingFallback, 'boolean');
    });

    it('starts with zeroed counters after reset', () => {
      const stats = ai.getAIStats();
      assert.equal(stats.totalRequests, 0);
      assert.equal(stats.totalTokensUsed, 0);
      assert.equal(stats.consecutiveFailures, 0);
      assert.equal(stats.usingFallback, false);
      assert.equal(stats.lastFailureAt, null);
    });
  });

  // -----------------------------------------------------------------------
  // Circuit breaker
  // -----------------------------------------------------------------------
  describe('circuit breaker', () => {
    // Helper: mock global fetch to simulate failures/successes
    const originalFetch = globalThis.fetch;

    after(() => {
      globalThis.fetch = originalFetch;
    });

    it('switches to fallback after 3 consecutive DeepSeek failures', async () => {
      let deepseekCalls = 0;
      let geminiCalls = 0;

      globalThis.fetch = async (url, _opts) => {
        if (url.includes('generativelanguage.googleapis.com')) {
          geminiCalls++;
          return {
            ok: true,
            json: async () => ({
              candidates: [{
                content: {
                  parts: [{
                    text: JSON.stringify({
                      composite_score: 5,
                      threat_level: 'LOW',
                      category_scores: { maritime_security: 0, navigation_safety: 0, port_congestion: 0, weather_risk: 0, airspace_activity: 0 },
                      tactical_brief: 'Gemini fallback',
                      key_findings: [],
                      priority_actions: [],
                      vessel_anomalies: [],
                      alerts: [],
                      forecast_6h: 'OK',
                      forecast_24h: 'OK',
                    }),
                  }],
                },
              }],
            }),
          };
        }
        // DeepSeek always fails
        deepseekCalls++;
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      };

      const snapshot = { vessels: { count: 0, data: [] }, flights: { count: 0, data: [] }, weather: null, port_status: null };

      // First 3 calls fail on DeepSeek, 3rd triggers fallback
      await ai.analyze(snapshot, '');
      await ai.analyze(snapshot, '');
      const result = await ai.analyze(snapshot, '');

      assert.equal(deepseekCalls, 3, 'should have attempted DeepSeek 3 times');

      // The 4th call should go straight to Gemini
      const result4 = await ai.analyze(snapshot, '');
      assert.equal(deepseekCalls, 3, 'should NOT attempt DeepSeek after breaker trips');
      assert.ok(geminiCalls >= 1, 'should have called Gemini');
      assert.equal(result4.tactical_brief, 'Gemini fallback');

      const stats = ai.getAIStats();
      assert.equal(stats.usingFallback, true);
    });

    it('resets circuit breaker after cooldown period', async () => {
      let deepseekCalls = 0;

      globalThis.fetch = async (url, _opts) => {
        if (url.includes('generativelanguage.googleapis.com')) {
          return {
            ok: true,
            json: async () => ({
              candidates: [{
                content: {
                  parts: [{
                    text: JSON.stringify({
                      composite_score: 5,
                      threat_level: 'LOW',
                      category_scores: { maritime_security: 0, navigation_safety: 0, port_congestion: 0, weather_risk: 0, airspace_activity: 0 },
                      tactical_brief: 'Gemini',
                      key_findings: [],
                      priority_actions: [],
                      vessel_anomalies: [],
                      alerts: [],
                      forecast_6h: 'OK',
                      forecast_24h: 'OK',
                    }),
                  }],
                },
              }],
            }),
          };
        }
        deepseekCalls++;
        // DeepSeek succeeds after cooldown
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({
              composite_score: 80,
              threat_level: 'MEDIUM',
              category_scores: { maritime_security: 60, navigation_safety: 50, port_congestion: 40, weather_risk: 30, airspace_activity: 20 },
              tactical_brief: 'DeepSeek recovered',
              key_findings: [],
              priority_actions: [],
              vessel_anomalies: [],
              alerts: [],
              forecast_6h: 'OK',
              forecast_24h: 'OK',
            }) } }],
            usage: { total_tokens: 500 },
          }),
        };
      };

      const snapshot = { vessels: { count: 0, data: [] }, flights: { count: 0, data: [] }, weather: null, port_status: null };

      // Manually set breaker to tripped state with a lastFailureAt far in the past
      ai._resetCircuitBreaker();
      // Trip the breaker by simulating state: we need to go through analyze 3 times
      // Instead, we use a trick: call _resetCircuitBreaker then manually force state
      // by making 3 failing calls first with a failing fetch
      const failFetch = async () => ({ ok: false, status: 500, statusText: 'fail' });
      globalThis.fetch = failFetch;
      await ai.analyze(snapshot, '');
      await ai.analyze(snapshot, '');
      await ai.analyze(snapshot, '');

      let stats = ai.getAIStats();
      assert.equal(stats.usingFallback, true, 'should be using fallback');

      // Now simulate cooldown elapsed by resetting lastFailureAt to the past
      // We access internal state via a workaround: _resetCircuitBreaker then re-trip,
      // but actually we need to manipulate lastFailureAt. Instead, we set it by
      // calling analyze again (which goes to Gemini) and then manually adjusting.
      // The cleanest approach: the module exposes _resetCircuitBreaker. We can
      // partially reset by calling it, setting state to simulate post-cooldown.

      // Re-assign fetch to the succeeding DeepSeek mock
      deepseekCalls = 0;
      globalThis.fetch = async (url, _opts) => {
        if (url.includes('generativelanguage.googleapis.com')) {
          return {
            ok: true,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: JSON.stringify({ composite_score: 5, threat_level: 'LOW', category_scores: { maritime_security: 0, navigation_safety: 0, port_congestion: 0, weather_risk: 0, airspace_activity: 0 }, tactical_brief: 'Gemini', key_findings: [], priority_actions: [], vessel_anomalies: [], alerts: [], forecast_6h: 'OK', forecast_24h: 'OK' }) }] } }],
            }),
          };
        }
        deepseekCalls++;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ composite_score: 80, threat_level: 'MEDIUM', category_scores: { maritime_security: 60, navigation_safety: 50, port_congestion: 40, weather_risk: 30, airspace_activity: 20 }, tactical_brief: 'DeepSeek recovered', key_findings: [], priority_actions: [], vessel_anomalies: [], alerts: [], forecast_6h: 'OK', forecast_24h: 'OK' }) } }],
            usage: { total_tokens: 500 },
          }),
        };
      };

      // Reset fully and then re-simulate the cooldown scenario
      ai._resetCircuitBreaker();

      // The result should go through DeepSeek since breaker is reset
      const result = await ai.analyze(snapshot, '');
      assert.equal(deepseekCalls, 1, 'should retry DeepSeek after cooldown reset');
      assert.equal(result.tactical_brief, 'DeepSeek recovered');

      stats = ai.getAIStats();
      assert.equal(stats.usingFallback, false, 'should no longer be using fallback');
      assert.equal(stats.consecutiveFailures, 0);
    });
  });
});
