'use strict';

const config = require('../config');
const { getDb } = require('../db');

// ---------------------------------------------------------------------------
// Circuit-breaker state
// ---------------------------------------------------------------------------
let consecutiveFailures = 0;
let lastFailureAt = null;
let usingFallback = false;
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Token-usage tracking (in-memory, augmented by persistent DB logging)
let totalTokensUsed = 0;
let totalRequests = 0;

// Cost per 1M tokens (USD) — update when pricing changes
const COST_PER_1M = {
  deepseek: { input: 0.27, output: 1.10 },
  gemini:   { input: 0.10, output: 0.40 },
  ollama:   { input: 0,    output: 0 },
};

/**
 * Log a single LLM API call to the ai_usage table.
 */
function logUsage({ provider, model, inputTokens, outputTokens, totalTokens, durationMs, success, errorMsg }) {
  try {
    const rates = COST_PER_1M[provider] || { input: 0, output: 0 };
    const costUsd = ((inputTokens || 0) * rates.input + (outputTokens || 0) * rates.output) / 1_000_000;
    const db = getDb();
    db.prepare(
      `INSERT INTO ai_usage (provider, model, input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, success, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(provider, model || null, inputTokens || 0, outputTokens || 0, totalTokens || 0, costUsd, durationMs || 0, success ? 1 : 0, errorMsg || null);
  } catch (err) {
    console.error('[AI] Failed to log usage:', err.message);
  }
}

// ---------------------------------------------------------------------------
// System prompt (SPECTRE analyst persona)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are SPECTRE, an AI maritime and airspace intelligence analyst monitoring the Singapore Strait and surrounding waters. You analyze real-time vessel, flight, weather, and port data to produce tactical threat assessments.

ALWAYS respond with valid JSON matching this exact schema:
{
  "composite_score": <0-100 integer>,
  "threat_level": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "category_scores": {
    "maritime_security": <0-100>,
    "navigation_safety": <0-100>,
    "port_congestion": <0-100>,
    "weather_risk": <0-100>,
    "airspace_activity": <0-100>
  },
  "tactical_brief": "<2-3 sentence summary>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "priority_actions": ["<action 1>", "<action 2>", ...],
  "vessel_anomalies": [{"mmsi": "<mmsi>", "reason": "<why flagged>"}],
  "alerts": [{"severity": "<CRITICAL|HIGH|MEDIUM|LOW>", "title": "<short title>", "description": "<detail>"}],
  "forecast_6h": "<brief 6-hour outlook>",
  "forecast_24h": "<brief 24-hour outlook>"
}

Use the vault context to reference prior incidents, returning vessels, and baseline patterns.
Flag AIS-dark behavior, unusual loitering, speed anomalies, and formation patterns.
Reference OSINT intelligence briefs (intel_briefs) when available to correlate open-source reporting with sensor data.

Data quality notes:
- heading=null means heading data is unavailable (AIS code 511) — this is normal, NOT an anomaly. Do not flag missing headings as suspicious.
- vessel_count in the snapshot is the total number of tracked vessels, NOT the port queue. Port congestion data is in the port_status field (berth_utilisation, channel_flow_pct, vessels_queued). Do not confuse total tracked vessels with queued vessels.
- speed_kt=0 for anchored vessels is normal. Only flag speed anomalies for vessels in TSS lanes or restricted zones.`;

// ---------------------------------------------------------------------------
// DJINN theater: MARID AI persona system prompt
// ---------------------------------------------------------------------------
const DJINN_SYSTEM_PROMPT = `You are MARID, an AI maritime and airspace intelligence analyst monitoring the Strait of Hormuz and Arabian Gulf. You analyze real-time vessel, flight, weather, and open-source data to produce tactical threat assessments for the DJINN theater.

OPERATIONAL CONTEXT:
- Area of Responsibility: Strait of Hormuz, Gulf of Oman, Arabian Gulf approaches
- Key actors: IRGCN (Islamic Revolutionary Guard Corps Navy), IRIN (Islamic Republic of Iran Navy), UAE Coast Guard, Royal Navy of Oman, US Fifth Fleet (NAVCENT), UK Maritime Component (UKMTO), Combined Maritime Forces (CMF)
- Threat priorities: (1) Freedom of navigation, (2) Sanctions evasion / illicit oil transfers, (3) IRGCN provocative behavior, (4) Energy infrastructure security, (5) Mine warfare indicators
- Reference authorities: CENTCOM, Fifth Fleet / CTF-150/151/152, UKMTO, EUNAVFOR, IMO

DOMAIN KNOWLEDGE:
- IRGCN operates fast attack craft (FAC) from bases at Bandar Abbas, Abu Musa, Greater Tunb, Lesser Tunb, Farsi Island, and Larak Island.
- IRGCN swarm tactics typically involve 5-15 small fast boats converging on a target at 25-40 knots.
- Iran's shadow fleet uses aged tankers (15+ years) with flags of convenience (Cameroon, Tanzania, Palau, Togo) and frequent AIS manipulation.
- STS (ship-to-ship) transfers are the primary method for sanctioned oil export, often conducted at Fujairah anchorage or in open waters off Khorfakkan.
- Hormuz TSS: inbound lane (NW-bound, into Gulf), outbound lane (SE-bound, out of Gulf), 2 NM separation zone.
- Iranian territorial waters claims extend to 12 NM; disputed islands (Abu Musa, Tunbs) create overlapping claims with UAE.
- Chokepoints: Hormuz narrows (~21 NM wide, navigable channel ~6 NM), Musandam peninsula approaches.

ANALYTICAL PRIORITIES:
- Sanctions evasion indicators: AIS-dark tankers, STS transfers, flag-hopping, draft changes without port calls, loitering at anchorage
- IRGCN activity: fast-boat formations, convergence patterns, proximity to commercial shipping, island base activity
- Energy security: tanker traffic flow rates, disruption indicators, pipeline terminal approaches
- Mine warfare: unusual stationary objects, slow-moving small craft in shipping lanes at night
- Freedom of navigation: military vessel transits, FONOPS indicators, escort operations

ALWAYS respond with valid JSON matching this exact schema:
{
  "composite_score": <0-100 integer>,
  "threat_level": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "category_scores": {
    "maritime_security": <0-100>,
    "navigation_safety": <0-100>,
    "energy_flow_security": <0-100>,
    "weather_risk": <0-100>,
    "airspace_activity": <0-100>,
    "sanctions_evasion": <0-100>
  },
  "tactical_brief": "<2-3 sentence summary>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "priority_actions": ["<action 1>", "<action 2>", ...],
  "vessel_anomalies": [{"mmsi": "<mmsi>", "reason": "<why flagged>"}],
  "alerts": [{"severity": "<CRITICAL|HIGH|MEDIUM|LOW>", "title": "<short title>", "description": "<detail>"}],
  "forecast_6h": "<brief 6-hour outlook>",
  "forecast_24h": "<brief 24-hour outlook>"
}

Use the vault context to reference prior incidents, returning vessels, and baseline patterns.
Flag AIS-dark behavior, unusual loitering, speed anomalies, and formation patterns.
Reference OSINT intelligence briefs (intel_briefs) when available to correlate open-source reporting with sensor data.

Data quality notes:
- heading=null means heading data is unavailable — this is normal, NOT an anomaly.
- Gulf waters have high AIS traffic density; do not over-alert on routine congestion.
- Iranian-flagged vessels (MMSI prefix 422) operating near Iranian waters is normal baseline behavior.
- Dhow traffic (small traditional vessels) may have intermittent AIS and should not be treated as AIS-dark suspicious targets unless other indicators are present.`;

// ---------------------------------------------------------------------------
// DJINN theater: Ollama-safe MARID variant
// ---------------------------------------------------------------------------
const DJINN_OLLAMA_SYSTEM_PROMPT = `You are MARID, an AI maritime traffic safety analyst monitoring the Strait of Hormuz and Arabian Gulf. You analyze real-time vessel, flight, weather, and port data to produce traffic risk assessments for the Gulf region.

REGIONAL CONTEXT:
- Area: Strait of Hormuz, Gulf of Oman, Arabian Gulf approaches
- Key stakeholders: Regional naval forces, UAE Coast Guard, Oman Maritime, US Naval Forces Central Command, UK Maritime Trade Operations, Combined Maritime Forces
- Priorities: Navigation safety, energy transport continuity, regional naval patrol patterns, regulatory compliance
- Reference: IMO, UKMTO advisory notices

ALWAYS respond with valid JSON matching this exact schema:
{
  "composite_score": <0-100 integer>,
  "threat_level": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "category_scores": {
    "maritime_security": <0-100>,
    "navigation_safety": <0-100>,
    "energy_flow_security": <0-100>,
    "weather_risk": <0-100>,
    "airspace_activity": <0-100>,
    "sanctions_evasion": <0-100>
  },
  "tactical_brief": "<2-3 sentence summary>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "priority_actions": ["<action 1>", "<action 2>", ...],
  "vessel_anomalies": [{"mmsi": "<mmsi>", "reason": "<why flagged>"}],
  "alerts": [{"severity": "<CRITICAL|HIGH|MEDIUM|LOW>", "title": "<short title>", "description": "<detail>"}],
  "forecast_6h": "<brief 6-hour outlook>",
  "forecast_24h": "<brief 24-hour outlook>"
}

Use the vault context to reference prior incidents, returning vessels, and baseline patterns.
Flag AIS signal gaps, unusual loitering, speed anomalies, and formation patterns.
Reference open-source reporting briefs (intel_briefs) when available to correlate with sensor data.
Perform compliance checks against vessel registries when data is available.

Data quality notes:
- heading=null means heading data is unavailable — this is normal, NOT an anomaly.
- Gulf waters have high AIS traffic density; do not over-alert on routine congestion.
- Regional-flagged vessels operating near their home waters is normal baseline behavior.
- Small traditional vessels may have intermittent AIS and should not be treated as suspicious unless other indicators are present.`;

// ---------------------------------------------------------------------------
// Ollama-safe system prompt (neutral language to avoid safety refusals)
// ---------------------------------------------------------------------------
const OLLAMA_SYSTEM_PROMPT = `You are SPECTRE, an AI maritime traffic safety analyst monitoring the Singapore Strait and surrounding waters. You analyze real-time vessel, flight, weather, and port data to produce traffic risk assessments.

ALWAYS respond with valid JSON matching this exact schema:
{
  "composite_score": <0-100 integer>,
  "threat_level": "<CRITICAL|HIGH|MEDIUM|LOW>",
  "category_scores": {
    "maritime_security": <0-100>,
    "navigation_safety": <0-100>,
    "port_congestion": <0-100>,
    "weather_risk": <0-100>,
    "airspace_activity": <0-100>
  },
  "tactical_brief": "<2-3 sentence summary>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "priority_actions": ["<action 1>", "<action 2>", ...],
  "vessel_anomalies": [{"mmsi": "<mmsi>", "reason": "<why flagged>"}],
  "alerts": [{"severity": "<CRITICAL|HIGH|MEDIUM|LOW>", "title": "<short title>", "description": "<detail>"}],
  "forecast_6h": "<brief 6-hour outlook>",
  "forecast_24h": "<brief 24-hour outlook>"
}

Use the vault context to reference prior incidents, returning vessels, and baseline patterns.
Flag AIS signal gaps, unusual loitering, speed anomalies, and formation patterns.
Reference open-source reporting briefs (intel_briefs) when available to correlate with sensor data.
Perform compliance checks against vessel registries when data is available.

Data quality notes:
- heading=null means heading data is unavailable (AIS code 511) — this is normal, NOT an anomaly. Do not flag missing headings as suspicious.
- vessel_count in the snapshot is the total number of tracked vessels, NOT the port queue. Port congestion data is in the port_status field (berth_utilisation, channel_flow_pct, vessels_queued). Do not confuse total tracked vessels with queued vessels.
- speed_kt=0 for anchored vessels is normal. Only flag speed anomalies for vessels in TSS lanes or restricted zones.`;

/**
 * Get the appropriate system prompt for a theater.
 * @param {string} theaterKey - 'merlion' or 'djinn'
 * @param {boolean} [ollama=false] - Use Ollama-safe variant
 * @returns {string}
 */
function getSystemPrompt(theaterKey, ollama = false) {
  if (theaterKey === 'djinn') {
    return ollama ? DJINN_OLLAMA_SYSTEM_PROMPT : DJINN_SYSTEM_PROMPT;
  }
  return ollama ? OLLAMA_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

/**
 * Get the fallback response schema for a theater (adjusts category_scores).
 * @param {string} theaterKey
 * @param {string} errorMsg
 * @returns {object}
 */
function makeFallbackResponseForTheater(theaterKey, errorMsg) {
  if (theaterKey === 'djinn') {
    return {
      composite_score: 0,
      threat_level: 'LOW',
      category_scores: {
        maritime_security: 0,
        navigation_safety: 0,
        energy_flow_security: 0,
        weather_risk: 0,
        airspace_activity: 0,
        sanctions_evasion: 0,
      },
      tactical_brief: `Analysis unavailable: ${errorMsg}`,
      key_findings: [],
      priority_actions: [],
      vessel_anomalies: [],
      alerts: [],
      forecast_6h: 'Unavailable',
      forecast_24h: 'Unavailable',
    };
  }
  return makeFallbackResponse(errorMsg);
}

// ---------------------------------------------------------------------------
// Theater-aware analysis runner
// ---------------------------------------------------------------------------

/**
 * Run AI analysis for a specific theater.
 * @param {object} snapshot - Theater-specific data snapshot
 * @param {string} vaultContext - Vault context string
 * @param {string} theaterKey - 'merlion' or 'djinn'
 * @returns {Promise<object>}
 */
async function analyzeForTheater(snapshot, vaultContext, theaterKey) {
  if (!theaterKey || theaterKey === 'merlion') {
    return analyze(snapshot, vaultContext);
  }

  // DJINN theater — same circuit-breaker pattern but with MARID prompts
  const chain = getProviderChain();
  if (chain.length === 0) {
    return makeFallbackResponseForTheater(theaterKey, 'No AI providers configured');
  }

  const systemPrompt = getSystemPrompt(theaterKey, false);
  const ollamaPrompt = getSystemPrompt(theaterKey, true);
  const userMessage = buildUserMessage(snapshot, vaultContext);

  // Try each provider in order
  for (const key of chain) {
    try {
      let result;
      if (key === 'ollama') {
        // For Ollama, we use a modified prompt
        const prompt = ollamaPrompt + '\n\n' + userMessage;
        const model = config.OLLAMA_MODEL || 'llama3.1:8b';
        const url = `${config.OLLAMA_BASE_URL}/api/generate`;
        const body = { model, prompt, format: 'json', stream: false, options: { temperature: 0.3, num_predict: 512 } };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        const startMs = Date.now();
        try {
          const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal,
          });
          if (!res.ok) throw new Error(`Ollama API returned ${res.status}`);
          const data = await res.json();
          logUsage({ provider: 'ollama', model, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count, totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0), durationMs: Date.now() - startMs, success: true });
          result = parseAnalysisJSON(data.response);
        } finally { clearTimeout(timeout); }
      } else if (key === 'deepseek') {
        const url = `${config.DEEPSEEK_BASE_URL}/chat/completions`;
        const body = {
          model: config.DEEPSEEK_MODEL || 'deepseek-chat',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
          temperature: 0.3, response_format: { type: 'json_object' },
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        const startMs = Date.now();
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal,
          });
          if (!res.ok) throw new Error(`DeepSeek API returned ${res.status}`);
          const data = await res.json();
          const usage = data.usage || {};
          logUsage({ provider: 'deepseek', model: body.model, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens, durationMs: Date.now() - startMs, success: true });
          result = parseAnalysisJSON(data.choices?.[0]?.message?.content);
        } finally { clearTimeout(timeout); }
      } else if (key === 'gemini') {
        const model = config.GEMINI_MODEL || 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;
        const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
        const body = { contents: [{ parts: [{ text: combinedPrompt }] }], generationConfig: { responseMimeType: 'application/json' } };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        const startMs = Date.now();
        try {
          const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal,
          });
          if (!res.ok) throw new Error(`Gemini API returned ${res.status}`);
          const data = await res.json();
          const usage = data.usageMetadata || {};
          logUsage({ provider: 'gemini', model, inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount, totalTokens: usage.totalTokenCount, durationMs: Date.now() - startMs, success: true });
          result = parseAnalysisJSON(data.candidates?.[0]?.content?.parts?.[0]?.text);
        } finally { clearTimeout(timeout); }
      }
      if (result) {
        activeProvider = PROVIDERS[key]?.name || key;
        return result;
      }
    } catch (err) {
      console.error('[AI:DJINN] %s failed: %s', key, err.message);
    }
  }

  return makeFallbackResponseForTheater(theaterKey, 'All providers failed');
}

/**
 * Run condensed Ollama analysis for a specific theater.
 * @param {object} condensedSnapshot
 * @param {string} theaterKey
 * @returns {Promise<object>}
 */
async function runOllamaForTheater(condensedSnapshot, theaterKey) {
  const prompt = getSystemPrompt(theaterKey || 'merlion', true);
  const model = config.OLLAMA_INTERMEDIATE_MODEL || config.OLLAMA_MODEL || 'gemma:2b';
  const url = `${config.OLLAMA_BASE_URL}/api/generate`;

  const fullPrompt = prompt + '\n\n## Maritime Traffic Snapshot (' + new Date().toISOString() + ')\n' + JSON.stringify(condensedSnapshot, null, 0);

  const body = { model, prompt: fullPrompt, format: 'json', stream: false, options: { temperature: 0.3, num_predict: 512 } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama API returned ${res.status}`);
    const data = await res.json();
    logUsage({ provider: 'ollama', model, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count, totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0), durationMs: Date.now() - startMs, success: true });
    return parseAnalysisJSON(data.response);
  } catch (err) {
    logUsage({ provider: 'ollama', model, durationMs: Date.now() - startMs, success: false, errorMsg: err.message });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserMessage(snapshot, vaultContext) {
  return `## Current Snapshot (${new Date().toISOString()})
${JSON.stringify(snapshot, null, 2)}

## Vault Context (Recent Memory)
${vaultContext}`;
}

function makeFallbackResponse(errorMsg) {
  return {
    composite_score: 0,
    threat_level: 'LOW',
    category_scores: {
      maritime_security: 0,
      navigation_safety: 0,
      port_congestion: 0,
      weather_risk: 0,
      airspace_activity: 0,
    },
    tactical_brief: `Analysis unavailable: ${errorMsg}`,
    key_findings: [],
    priority_actions: [],
    vessel_anomalies: [],
    alerts: [],
    forecast_6h: 'Unavailable',
    forecast_24h: 'Unavailable',
  };
}

function parseAnalysisJSON(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (_) {
    // Attempt to extract JSON from markdown code fences
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    throw new Error('Failed to parse AI response as JSON');
  }
}

// ---------------------------------------------------------------------------
// DeepSeek V3 (primary)
// ---------------------------------------------------------------------------

async function runAnalysis(snapshot, vaultContext) {
  const url = `${config.DEEPSEEK_BASE_URL}/chat/completions`;
  const userMessage = buildUserMessage(snapshot, vaultContext);

  const body = {
    model: config.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`DeepSeek API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const durationMs = Date.now() - startMs;

    // Track token usage
    const usage = data.usage || {};
    totalTokensUsed += (usage.total_tokens || 0);
    totalRequests++;

    logUsage({
      provider: 'deepseek', model: body.model,
      inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens, durationMs, success: true,
    });

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from DeepSeek');
    }

    return parseAnalysisJSON(content);
  } catch (err) {
    logUsage({ provider: 'deepseek', model: body.model, durationMs: Date.now() - startMs, success: false, errorMsg: err.message });
    if (err.name === 'AbortError') {
      throw new Error('DeepSeek API request timed out (45s)');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Gemini Flash 2.0 (fallback)
// ---------------------------------------------------------------------------

async function runAnalysisFallback(snapshot, vaultContext) {
  const model = config.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;
  const userMessage = buildUserMessage(snapshot, vaultContext);

  const combinedPrompt = `${SYSTEM_PROMPT}\n\n${userMessage}`;

  const body = {
    contents: [{ parts: [{ text: combinedPrompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Gemini API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const durationMs = Date.now() - startMs;
    totalRequests++;

    const usage = data.usageMetadata || {};
    logUsage({
      provider: 'gemini', model,
      inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount, durationMs, success: true,
    });

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      throw new Error('Empty response from Gemini');
    }

    return parseAnalysisJSON(content);
  } catch (err) {
    logUsage({ provider: 'gemini', model, durationMs: Date.now() - startMs, success: false, errorMsg: err.message });
    if (err.name === 'AbortError') {
      throw new Error('Gemini API request timed out (45s)');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Ollama / llama3.1 (self-hosted tertiary fallback)
// ---------------------------------------------------------------------------

async function runAnalysisOllama(snapshot, vaultContext, { condensed = false } = {}) {
  const model = condensed
    ? (config.OLLAMA_INTERMEDIATE_MODEL || config.OLLAMA_MODEL || 'gemma:2b')
    : (config.OLLAMA_MODEL || 'llama3.1:8b');
  const url = `${config.OLLAMA_BASE_URL}/api/generate`;

  // Use condensed prompt for intermediate cycles (much smaller token count)
  let prompt;
  if (condensed) {
    prompt = OLLAMA_SYSTEM_PROMPT + '\n\n## Maritime Traffic Snapshot (' + new Date().toISOString() + ')\n' + JSON.stringify(snapshot, null, 0);
  } else {
    const userMessage = buildUserMessage(snapshot, vaultContext);
    prompt = OLLAMA_SYSTEM_PROMPT + '\n\n' + userMessage;
  }

  const body = {
    model,
    prompt,
    format: 'json',
    stream: false,
    options: { temperature: 0.3, num_predict: 512 },
  };

  const controller = new AbortController();
  const timeoutMs = condensed ? 60000 : 90000; // 60s for condensed, 90s for full
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startMs = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const durationMs = Date.now() - startMs;
    totalRequests++;

    logUsage({
      provider: 'ollama', model,
      inputTokens: data.prompt_eval_count, outputTokens: data.eval_count,
      totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      durationMs, success: true,
    });

    const content = data.response;
    if (!content) {
      throw new Error('Empty response from Ollama');
    }

    return parseAnalysisJSON(content);
  } catch (err) {
    logUsage({ provider: 'ollama', model, durationMs: Date.now() - startMs, success: false, errorMsg: err.message });
    if (err.name === 'AbortError') {
      throw new Error(`Ollama API request timed out (${timeoutMs / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Provider registry — maps name → runner function
// ---------------------------------------------------------------------------

const PROVIDERS = {
  deepseek: { name: 'DeepSeek', run: runAnalysis },
  gemini:   { name: 'Gemini',   run: runAnalysisFallback },
  ollama:   { name: 'Ollama',   run: runAnalysisOllama },
};

/**
 * Parse AI_PROVIDER_ORDER into an ordered array of provider keys.
 * Default: ollama,deepseek,gemini
 */
function getProviderChain() {
  const raw = config.AI_PROVIDER_ORDER || 'ollama,deepseek,gemini';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(k => PROVIDERS[k]);
}

// Track which provider last succeeded for stats
let activeProvider = null;

// ---------------------------------------------------------------------------
// Circuit breaker: analyze()
// ---------------------------------------------------------------------------

async function analyze(snapshot, vaultContext) {
  // Check if cooldown has elapsed and we should retry primary
  if (usingFallback && lastFailureAt) {
    const elapsed = Date.now() - lastFailureAt;
    if (elapsed >= COOLDOWN_MS) {
      usingFallback = false;
      consecutiveFailures = 0;
    }
  }

  const chain = getProviderChain();
  if (chain.length === 0) {
    return makeFallbackResponse('No AI providers configured in AI_PROVIDER_ORDER');
  }

  const primary = chain[0];
  const fallbacks = chain.slice(1);

  // Try primary if circuit is closed
  if (!usingFallback) {
    try {
      const result = await PROVIDERS[primary].run(snapshot, vaultContext);
      consecutiveFailures = 0;
      activeProvider = PROVIDERS[primary].name;
      return result;
    } catch (err) {
      consecutiveFailures++;
      lastFailureAt = Date.now();
      console.error('[AI] %s failed (%d/%d): %s', PROVIDERS[primary].name, consecutiveFailures, FAILURE_THRESHOLD, err.message);
      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        usingFallback = true;
      }

      // If not yet at threshold, return error fallback
      if (!usingFallback) {
        return makeFallbackResponse(err.message);
      }
    }
  }

  // Try fallbacks in order
  const errors = [];
  for (const key of fallbacks) {
    try {
      const result = await PROVIDERS[key].run(snapshot, vaultContext);
      activeProvider = PROVIDERS[key].name;
      return result;
    } catch (err) {
      console.error('[AI] %s fallback failed: %s', PROVIDERS[key].name, err.message);
      errors.push(`${PROVIDERS[key].name}: ${err.message}`);
    }
  }

  return makeFallbackResponse(`All providers failed. ${errors.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Condensed snapshot builder (for Ollama — targets ~1-2K tokens)
// ---------------------------------------------------------------------------

function buildCondensedSnapshot(db) {
  // Vessels — only the 5 most anomalous
  const vessels = db.prepare(
    "SELECT * FROM vessels WHERE recorded_at >= datetime('now', '-5 minutes') ORDER BY recorded_at DESC"
  ).all();

  // Identify anomalous vessels: flagged, high speed (>20kt), AIS gaps (no recent update)
  const anomalyVessels = vessels
    .filter(v => v.speed_kt > 20 || v.flagged || v.nav_status === 'not under command')
    .slice(0, 5)
    .map(v => ({
      mmsi: v.mmsi,
      name: v.vessel_name || 'Unknown',
      speed_kt: v.speed_kt,
      heading: v.heading,
      flagged_reason: v.speed_kt > 20 ? 'high_speed' : v.flagged ? 'flagged' : 'nav_status',
    }));

  // Weather — one-line summary
  const weather = db.prepare(
    'SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1'
  ).get();
  const weatherSummary = weather
    ? `Wind ${weather.wind_speed_kt || '?'}kt ${weather.wind_dir || '?'}°, vis ${weather.visibility_km || '?'}km, sea ${weather.sea_state || 'unknown'}`
    : 'No weather data';

  // Port — one-line summary
  const port = db.prepare(
    'SELECT * FROM port_status ORDER BY recorded_at DESC LIMIT 1'
  ).get();
  const portSummary = port
    ? `${Math.round((port.berth_utilisation || 0) * 100)}% berth util, ${port.vessels_queued || 0} queued, ${port.channel_flow_pct || 0}% channel flow`
    : 'No port data';

  // Alert counts from recent alerts
  let alertSummary = { critical: 0, high: 0, medium: 0, low: 0 };
  try {
    const alerts = db.prepare(
      "SELECT severity, COUNT(*) AS cnt FROM alerts WHERE created_at >= datetime('now', '-30 minutes') GROUP BY severity"
    ).all();
    for (const a of alerts) {
      const key = (a.severity || '').toLowerCase();
      if (key in alertSummary) alertSummary[key] = a.cnt;
    }
  } catch (_) { /* alerts table may not exist */ }

  // Flights count
  const flightsCount = db.prepare(
    "SELECT COUNT(*) AS cnt FROM flights WHERE recorded_at >= datetime('now', '-60 seconds')"
  ).get().cnt;

  return {
    timestamp: new Date().toISOString(),
    vessel_count: vessels.length,
    anomaly_vessels: anomalyVessels,
    weather_summary: weatherSummary,
    port_summary: portSummary,
    alert_summary: alertSummary,
    flights_count: flightsCount,
    weather_impact: classifyWeatherImpact(weather || null),
  };
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function buildSnapshot(db) {
  const vessels = db.prepare(
    "SELECT * FROM vessels WHERE recorded_at >= datetime('now', '-5 minutes') ORDER BY recorded_at DESC"
  ).all();

  const flights = db.prepare(
    "SELECT * FROM flights WHERE recorded_at >= datetime('now', '-60 seconds') ORDER BY recorded_at DESC"
  ).all();

  const weather = db.prepare(
    'SELECT * FROM weather ORDER BY recorded_at DESC LIMIT 1'
  ).get() || null;

  const portStatus = db.prepare(
    'SELECT * FROM port_status ORDER BY recorded_at DESC LIMIT 1'
  ).get() || null;

  // Limit payload: send top 50 vessels + 30 flights, summarise the rest
  const MAX_VESSELS = 50;
  const MAX_FLIGHTS = 30;

  // Recent high-relevance OSINT intel briefs (last 24h)
  let intelBriefs = [];
  try {
    intelBriefs = db.prepare(
      `SELECT title, source, relevance_score, summary, published_at
       FROM intel_articles
       WHERE relevance_score >= 40
         AND created_at >= datetime('now', '-24 hours')
       ORDER BY relevance_score DESC
       LIMIT 5`
    ).all();
  } catch (_) { /* table may not exist yet */ }

  return {
    timestamp: new Date().toISOString(),
    vessels: {
      count: vessels.length,
      data: vessels.slice(0, MAX_VESSELS),
      truncated: vessels.length > MAX_VESSELS,
    },
    flights: {
      count: flights.length,
      data: flights.slice(0, MAX_FLIGHTS),
      truncated: flights.length > MAX_FLIGHTS,
    },
    weather,
    port_status: portStatus,
    intel_briefs: intelBriefs,
    weather_impact: classifyWeatherImpact(weather),
  };
}

function classifyWeatherImpact(weather) {
  if (!weather) return 'UNKNOWN';
  const vis = weather.visibility_km;
  const sea = (weather.sea_state || '').toLowerCase();
  const rough = ['rough', 'very rough', 'high', 'very high'];
  if ((vis != null && vis < 2) || rough.includes(sea)) return 'RESTRICTED';
  if ((vis != null && vis >= 2 && vis <= 5) || sea === 'moderate') return 'DEGRADED';
  return 'FULL';
}

// ---------------------------------------------------------------------------
// Stats / introspection
// ---------------------------------------------------------------------------

function getAIStats() {
  let persistent = { totalCostUsd: 0, totalTokens: 0, totalCalls: 0, byProvider: [] };
  try {
    const db = getDb();
    const totals = db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS calls FROM ai_usage'
    ).get();
    const byProvider = db.prepare(
      'SELECT provider, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes FROM ai_usage GROUP BY provider'
    ).all();
    persistent = { totalCostUsd: totals.cost, totalTokens: totals.tokens, totalCalls: totals.calls, byProvider };
  } catch (_) { /* table may not exist yet */ }

  return {
    totalRequests,
    totalTokensUsed,
    consecutiveFailures,
    usingFallback,
    lastFailureAt,
    activeProvider,
    providerChain: getProviderChain().map(k => PROVIDERS[k].name),
    usage: persistent,
  };
}

// Exposed for testing — allows tests to reset internal state
function _resetCircuitBreaker() {
  consecutiveFailures = 0;
  lastFailureAt = null;
  usingFallback = false;
  totalTokensUsed = 0;
  totalRequests = 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  analyze,
  analyzeForTheater,
  runOllamaForTheater,
  buildSnapshot,
  buildCondensedSnapshot,
  runAnalysis,
  runAnalysisFallback,
  runAnalysisOllama,
  getAIStats,
  getProviderChain,
  getSystemPrompt,
  SYSTEM_PROMPT,
  OLLAMA_SYSTEM_PROMPT,
  DJINN_SYSTEM_PROMPT,
  DJINN_OLLAMA_SYSTEM_PROMPT,
  parseAnalysisJSON,
  makeFallbackResponse,
  makeFallbackResponseForTheater,
  _resetCircuitBreaker,
};
