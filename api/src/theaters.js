'use strict';

/**
 * Theater configuration registry.
 * Each theater defines its region, database, map settings, and data source bounding boxes.
 */
module.exports = {
  merlion: {
    name: 'MERLION',
    region: 'Singapore Strait',
    dbPath: './data/spectre.db',
    mapCenter: [1.25, 103.85],
    mapZoom: 11,
    mapBounds: [[-12, 90], [28, 145]],
    aisBBox: [[103.0, 0.5], [105.0, 2.5]],
    aisStreamBBox: [[0.5, 103.0], [2.5, 105.0]],
    airspaceCenterKm: { lat: 1.35, lon: 103.82, radiusKm: 150 },
    flightBBox: { lamin: 0.5, lamax: 2.5, lomin: 103.0, lomax: 105.0 },

    // OSINT keywords for Singapore theater relevance
    osintKeywords: [
      'singapore strait', 'malacca strait', 'south china sea',
      'philip channel', 'pedra branca', 'horsburgh', 'changi',
      'jurong', 'batam', 'bintan', 'johor', 'pasir panjang',
      'piracy', 'robbery', 'boarding', 'recaap',
    ],
  },
  djinn: {
    name: 'DJINN',
    region: 'Strait of Hormuz',
    dbPath: './data/djinn.db',
    mapCenter: [26.0, 55.5],
    mapZoom: 7,
    mapBounds: [[22, 48], [30, 62]],
    aisBBox: [[51.0, 24.0], [58.0, 28.0]],
    aisStreamBBox: [[24.0, 51.0], [28.0, 58.0]],
    airspaceCenterKm: { lat: 26.25, lon: 56.25, radiusKm: 250 },
    flightBBox: { lamin: 24.0, lamax: 28.0, lomin: 51.0, lomax: 58.0 },

    // --- Geofences for Strait of Hormuz ---

    zones: {
      hormuz_tss: { lonMin: 56.0, lonMax: 56.5, latMin: 26.2, latMax: 26.6, label: 'Hormuz TSS' },
      iranian_tw: { lonMin: 55.5, lonMax: 57.0, latMin: 26.5, latMax: 27.2, label: 'Iranian Territorial Waters' },
      omani_tw: { lonMin: 56.0, lonMax: 56.6, latMin: 25.9, latMax: 26.3, label: 'Omani Territorial Waters (Musandam)' },
      bandar_abbas: { lonMin: 56.15, lonMax: 56.45, latMin: 27.05, latMax: 27.30, label: 'Bandar Abbas Port Area' },
      fujairah_anchorage: { lonMin: 56.20, lonMax: 56.50, latMin: 25.05, latMax: 25.25, label: 'Fujairah Anchorage' },
    },

    tssLanes: {
      // Inbound (westbound into Persian Gulf): southern lane ~26.2-26.35°N
      inbound: {
        lonMin: 56.0, lonMax: 56.5, latMin: 26.20, latMax: 26.35,
        expectedHeadingMin: 270, expectedHeadingMax: 360,  // westward (roughly 270-360)
        label: 'Hormuz TSS Inbound (southerly lane)',
      },
      // Outbound (eastbound from Persian Gulf): northern lane ~26.45-26.60°N
      outbound: {
        lonMin: 56.0, lonMax: 56.5, latMin: 26.45, latMax: 26.60,
        expectedHeadingMin: 90, expectedHeadingMax: 180,  // eastward (roughly 90-180)
        label: 'Hormuz TSS Outbound (northerly lane)',
      },
      // Separation zone between lanes: ~26.35-26.45°N
      separation: {
        lonMin: 56.0, lonMax: 56.5, latMin: 26.35, latMax: 26.45,
        label: 'Hormuz TSS Separation Zone',
      },
    },

    chokepoints: {
      hormuz_narrows: {
        lonMin: 56.0, lonMax: 56.5, latMin: 26.3, latMax: 26.6,
        threshold: 20,
        label: 'Strait of Hormuz Narrows (~33km wide)',
      },
      musandam_tip: {
        lonMin: 56.15, lonMax: 56.45, latMin: 26.05, latMax: 26.25,
        threshold: 12,
        label: 'Musandam Peninsula Tip',
      },
    },

    // OSINT keywords that make articles relevant to this theater
    osintKeywords: [
      'hormuz', 'persian gulf', 'gulf of oman', 'iran', 'iranian',
      'irgc', 'irgcn', 'bandar abbas', 'fujairah', 'musandam',
      'oman', 'uae', 'dubai', 'abu dhabi', 'jebel ali',
      'tanker seizure', 'oil tanker', 'strait of hormuz',
      'centcom', 'fifth fleet', 'navcent', 'ukmto', 'arabian sea',
    ],
  },
};
