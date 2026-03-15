'use strict';

// ---------------------------------------------------------------------------
// Regex-based entity extraction for maritime OSINT articles
// ---------------------------------------------------------------------------

const LOCATION_DICTIONARY = [
  'Philip Channel', 'Singapore Strait', 'Malacca Strait', 'Pedra Branca',
  'Horsburgh', 'Raffles Lighthouse', 'TSS', 'VTIS', 'Changi', 'Jurong',
  'Tuas', 'Pasir Panjang', 'Batam', 'Bintan', 'Johor', 'OPL',
  'Eastern Boarding Ground',
];

const THREAT_KEYWORDS = [
  'piracy', 'robbery', 'boarding', 'hijack', 'suspicious',
  'dark vessel', 'ais off', 'armed', 'tanker',
];

// Pre-compile location regex (case-insensitive)
const LOCATION_RE = new RegExp(
  LOCATION_DICTIONARY.map(loc => loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi'
);

const MMSI_RE = /\b([2-7]\d{8})\b/g;
const IMO_RE = /\bIMO\s*(\d{7})\b/gi;

// Vessel names: sequences of 2+ uppercase words near maritime keywords
const VESSEL_NAME_RE = /\b(MV|MT|SS|HMS|FPSO|LNG|FSO)[\s.]+([A-Z][A-Z0-9\s]{2,30})\b/g;

/**
 * Extract entities (MMSIs, IMOs, vessel names, locations) from text.
 * @param {string} text
 * @returns {{ mmsis: string[], imos: string[], vesselNames: string[], locations: string[] }}
 */
function extractEntities(text) {
  if (!text || typeof text !== 'string') {
    return { mmsis: [], imos: [], vesselNames: [], locations: [] };
  }

  const mmsis = [...new Set((text.match(MMSI_RE) || []))];
  const imos = [...new Set((text.match(IMO_RE) || []).map(m => m.replace(/\s/g, '').toUpperCase()))];

  const vesselNames = [];
  let vmatch;
  while ((vmatch = VESSEL_NAME_RE.exec(text)) !== null) {
    vesselNames.push(`${vmatch[1]} ${vmatch[2].trim()}`);
  }

  const locationMatches = text.match(LOCATION_RE) || [];
  const locations = [...new Set(locationMatches.map(l => l.trim()))];

  return { mmsis, imos, vesselNames: [...new Set(vesselNames)], locations };
}

/**
 * Score an article's relevance (0-100) for Singapore Strait monitoring.
 * @param {{ title?: string, summary?: string, published_at?: string }} article
 * @param {{ mmsis: string[], imos: string[], vesselNames: string[], locations: string[] }} entities
 * @returns {number}
 */
function scoreRelevance(article, entities) {
  let score = 0;
  const text = `${article.title || ''} ${article.summary || ''}`.toLowerCase();

  // Geographic hit: +30
  if (entities.locations.length > 0) {
    score += 30;
  }

  // Recency: +20 if within 24h, +10 if within 72h
  if (article.published_at) {
    const pubDate = new Date(article.published_at);
    const ageMs = Date.now() - pubDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours <= 24) {
      score += 20;
    } else if (ageHours <= 72) {
      score += 10;
    }
  }

  // Threat keywords: +5 each, max 25
  let threatScore = 0;
  for (const keyword of THREAT_KEYWORDS) {
    if (text.includes(keyword)) {
      threatScore += 5;
    }
  }
  score += Math.min(threatScore, 25);

  // Entity density: +25 if MMSI or vessel found
  if (entities.mmsis.length > 0 || entities.vesselNames.length > 0) {
    score += 25;
  }

  return Math.min(score, 100);
}

module.exports = { extractEntities, scoreRelevance, LOCATION_DICTIONARY, THREAT_KEYWORDS };
