'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  PORT_API: parseInt(process.env.PORT_API, 10) || 3001,
  PORT_WS: parseInt(process.env.PORT_WS, 10) || 3002,
  SQLITE_DB_PATH: process.env.SQLITE_DB_PATH || './data/spectre.db',

  // Multi-theater support
  ACTIVE_THEATER: process.env.ACTIVE_THEATER || 'merlion',
  THEATERS: require('./theaters'),

  // AIS / Maritime
  AISSTREAM_API_KEY: process.env.AISSTREAM_API_KEY || '',

  // MPA OCEANS-X (official Singapore vessel data)
  MPA_API_KEY: process.env.MPA_API_KEY || '',
  MPA_BASE_URL: process.env.MPA_BASE_URL || 'https://oceans-x.mpa.gov.sg/api/v1',

  // DeepSeek AI
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || '',

  // Gemini AI
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || '',

  // External data sources
  OPEN_METEO_BASE_URL: process.env.OPEN_METEO_BASE_URL || '',
  NEA_BASE_URL: process.env.NEA_BASE_URL || 'https://api.data.gov.sg/v1',
  NEA_API_KEY: process.env.NEA_API_KEY || '',
  ADSB_FI_BASE_URL: process.env.ADSB_FI_BASE_URL || '',

  // OpenSky
  OPENSKY_USERNAME: process.env.OPENSKY_USERNAME || '',
  OPENSKY_PASSWORD: process.env.OPENSKY_PASSWORD || '',

  // Additional data sources
  DATAGOV_BASE_URL: process.env.DATAGOV_BASE_URL || '',
  CELESTRAK_BASE_URL: process.env.CELESTRAK_BASE_URL || '',
  AVIATION_WEATHER_BASE_URL: process.env.AVIATION_WEATHER_BASE_URL || '',

  // Ollama AI (self-hosted fallback)
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.1:8b',
  OLLAMA_INTERMEDIATE_MODEL: process.env.OLLAMA_INTERMEDIATE_MODEL || 'gemma:2b',

  // AI provider order — comma-separated, first = primary, rest = fallbacks
  // Options: deepseek, gemini, ollama
  // Default: ollama,deepseek,gemini
  AI_PROVIDER_ORDER: process.env.AI_PROVIDER_ORDER || 'ollama,deepseek,gemini',

  // API authentication
  API_KEY: process.env.API_KEY || '',

  // C2 Integration Webhooks
  WEBHOOK_URLS: process.env.WEBHOOK_URLS || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  // Encryption
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '',

  // OSINT Intelligence Feed
  OSINT_POLL_INTERVAL_MS: parseInt(process.env.OSINT_POLL_INTERVAL_MS, 10) || 900000,
  OSINT_RSS_FEEDS: process.env.OSINT_RSS_FEEDS || [
    'https://www.recaap.org/resources/ck/files/alerts/RSS/RSS.xml',
    'https://gcaptain.com/feed/',
    'https://splash247.com/feed/',
    'https://www.seatrade-maritime.com/rss.xml',
    // Gulf / Hormuz relevant feeds
    'https://www.ukmto.org/indian-ocean/rss',
    'https://icc-ccs.org/index.php/piracy-reporting-centre/live-piracy-report?format=feed&type=rss',
    // CENTCOM press releases (Sprint 2 — DJINN enrichment)
    'https://www.centcom.mil/MEDIA/PRESS-RELEASES/RSS/',
    // Dryad Channel16 maritime security incidents (Sprint 2 — DJINN enrichment)
    'https://channel16.dryadglobal.com/feed/',
  ].join(','),
  OSINT_MIN_RELEVANCE: parseInt(process.env.OSINT_MIN_RELEVANCE, 10) || 20,
  OSINT_AI_MIN_RELEVANCE: parseInt(process.env.OSINT_AI_MIN_RELEVANCE, 10) || 40,

  // OFAC SDN daily refresh (Sprint 2)
  OFAC_SDN_URL: process.env.OFAC_SDN_URL || 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
  OFAC_REFRESH_INTERVAL_MS: parseInt(process.env.OFAC_REFRESH_INTERVAL_MS, 10) || 86400000, // 24 hours

  // OpenSanctions fuzzy API (Sprint 2 — optional, requires API key)
  OPENSANCTIONS_API_KEY: process.env.OPENSANCTIONS_API_KEY || '',
  OPENSANCTIONS_BASE_URL: process.env.OPENSANCTIONS_BASE_URL || 'https://api.opensanctions.org',

  // ACLED conflict events (Sprint 2 — optional, requires API key)
  ACLED_API_KEY: process.env.ACLED_API_KEY || '',
  ACLED_API_EMAIL: process.env.ACLED_API_EMAIL || '',
  ACLED_BASE_URL: process.env.ACLED_BASE_URL || 'https://api.acleddata.com/acled/read',
  ACLED_REFRESH_INTERVAL_MS: parseInt(process.env.ACLED_REFRESH_INTERVAL_MS, 10) || 86400000, // 24 hours

  // GDELT news events (no API key required, default enabled)
  GDELT_ENABLED: process.env.GDELT_ENABLED !== 'false',
  GDELT_REFRESH_INTERVAL_MS: parseInt(process.env.GDELT_REFRESH_INTERVAL_MS, 10) || 1800000, // 30 minutes

  // NASA FIRMS thermal detections (optional, requires free API key)
  FIRMS_API_KEY: process.env.FIRMS_API_KEY || '',
  FIRMS_REFRESH_INTERVAL_MS: parseInt(process.env.FIRMS_REFRESH_INTERVAL_MS, 10) || 21600000, // 6 hours

  // AI analysis cycle interval (minutes)
  AI_ANALYSIS_INTERVAL_MIN: parseInt(process.env.AI_ANALYSIS_INTERVAL_MIN, 10) || 120,

  // Ollama intermediate analysis interval (minutes) — runs between DeepSeek cycles
  OLLAMA_ANALYSIS_INTERVAL_MIN: parseInt(process.env.OLLAMA_ANALYSIS_INTERVAL_MIN, 10) || 30,

  // Vault & general
  VAULT_PATH: process.env.VAULT_PATH || './vault/star-merlion',
  DOMAIN: process.env.DOMAIN || 'localhost',
  NODE_ENV: process.env.NODE_ENV || 'development',
};
