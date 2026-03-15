'use client';

import { useState, useEffect, useMemo, memo } from 'react';
import L from 'leaflet';
import {
  MapContainer,
  TileLayer,
  Circle,
  CircleMarker,
  Polyline,
  Polygon,
  Marker,
  Tooltip,
  GeoJSON,
  ZoomControl,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import 'leaflet/dist/leaflet.css';
import { TRACK_COLORS } from './TrackPlayback';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SINGAPORE_CENTER = [1.30, 103.82];
const RANGE_RINGS_KM = [150, 300, 500];

const SHIP_PATH = 'M0,-6 L3,-2 L3,4 L2,6 L-2,6 L-3,4 L-3,-2 Z';
const PLANE_PATH = 'M0,-8 L2,-3 L2,2 L7,5 L7,7 L2,5 L2,7 L4,9 L4,10 L0,9 L-4,10 L-4,9 L-2,7 L-2,5 L-7,7 L-7,5 L-2,2 L-2,-3 Z';

// C6: Distinct SVG paths per vessel type
const VESSEL_PATHS = {
  tanker: 'M0,-6 L4,-2 L4,4 L3,6 L-3,6 L-4,4 L-4,-2 Z',           // wider hull
  cargo: 'M-3,-6 L3,-6 L3,5 L2,6 L-2,6 L-3,5 Z',                   // rectangular hull
  passenger: 'M0,-7 L2.5,-3 L2,3 L1.5,6 L-1.5,6 L-2,3 L-2.5,-3 Z', // sleek
  fishing: 'M0,-5 L2,-1 L2,3 L1,5 L-1,5 L-2,3 L-2,-1 Z',           // small
  naval: 'M0,-7 L5,0 L0,7 L-5,0 Z',                                  // diamond
  tug: 'M-2.5,-3 L2.5,-3 L2.5,3 L-2.5,3 Z',                         // small square
  default: SHIP_PATH,
};

const VESSEL_COLORS = {
  tanker:    { fill: '#8B4513', stroke: '#CD853F' },
  cargo:     { fill: '#003A70', stroke: '#4A90E2' },
  passenger: { fill: '#2563EB', stroke: '#60A5FA' },
  fishing:   { fill: '#059669', stroke: '#34D399' },
  naval:     { fill: '#7C3AED', stroke: '#A78BFA' },
  tug:       { fill: '#6B7280', stroke: '#9CA3AF' },
  default:   { fill: '#003A70', stroke: '#4A90E2' },
};

// C6: Map AIS ship type codes (0-99) to categories
function getVesselCategory(shipType) {
  if (shipType == null) return 'default';
  const code = Number(shipType);
  if (isNaN(code)) {
    // Try string matching
    const s = String(shipType).toLowerCase();
    if (s.includes('tanker')) return 'tanker';
    if (s.includes('cargo') || s.includes('container') || s.includes('bulk')) return 'cargo';
    if (s.includes('passenger') || s.includes('ferry')) return 'passenger';
    if (s.includes('fish')) return 'fishing';
    if (s.includes('naval') || s.includes('military') || s.includes('government') || s.includes('law enforcement')) return 'naval';
    if (s.includes('tug') || s.includes('pilot')) return 'tug';
    return 'default';
  }
  // AIS ship type codes
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code === 30) return 'fishing';
  if (code >= 31 && code <= 32) return 'tug';
  if (code >= 50 && code <= 59) return 'naval'; // Government/military
  if (code >= 35 && code <= 39) return 'naval'; // Military ops
  if (code === 52) return 'tug'; // Tug
  return 'default';
}

// Maritime boundary lines
const MARITIME_BORDERS = [
  {
    name: 'SG-MY Border',
    coords: [
      [103.500, 1.420], [103.600, 1.408], [103.700, 1.397],
      [103.800, 1.393], [103.900, 1.394], [104.000, 1.408],
      [104.060, 1.420],
    ],
  },
  {
    name: 'SG-ID Border (South)',
    coords: [
      [103.500, 1.235], [103.600, 1.240], [103.700, 1.245],
      [103.800, 1.248], [103.900, 1.248], [104.000, 1.242],
      [104.100, 1.230], [104.200, 1.215],
    ],
  },
  {
    name: 'MY-ID Border (East)',
    coords: [
      [104.200, 1.215], [104.250, 1.250], [104.300, 1.290],
      [104.350, 1.320], [104.400, 1.350],
    ],
  },
];

const TSS_LANES = [
  {
    name: 'Eastbound Lane',
    color: '#22d3ee40',
    stroke: '#22d3ee',
    arrow: '\u2192',
    coords: [
      [103.45, 1.17], [103.55, 1.175], [103.65, 1.18],
      [103.75, 1.185], [103.82, 1.19], [103.90, 1.195],
      [104.00, 1.20], [104.10, 1.21], [104.20, 1.225],
      [104.30, 1.24], [104.40, 1.26],
    ],
  },
  {
    name: 'Westbound Lane',
    color: '#f9731640',
    stroke: '#f97316',
    arrow: '\u2190',
    coords: [
      [104.40, 1.22], [104.30, 1.205], [104.20, 1.19],
      [104.10, 1.175], [104.00, 1.165], [103.90, 1.16],
      [103.82, 1.155], [103.75, 1.15], [103.65, 1.145],
      [103.55, 1.14], [103.45, 1.135],
    ],
  },
  {
    name: 'Separation Zone',
    color: '#fbbf2420',
    stroke: '#fbbf24',
    coords: [
      [103.45, 1.153], [103.65, 1.163], [103.82, 1.173],
      [104.00, 1.183], [104.20, 1.208], [104.40, 1.24],
    ],
  },
];

const ZONES = [
  {
    name: 'SG Anchorage',
    coords: [[103.72, 1.22], [103.82, 1.22], [103.82, 1.17], [103.72, 1.17], [103.72, 1.22]],
  },
  {
    name: 'E. Boarding Ground',
    coords: [[104.05, 1.25], [104.15, 1.25], [104.15, 1.20], [104.05, 1.20], [104.05, 1.25]],
  },
];

const LABELS = [
  { name: 'SINGAPORE', pos: [1.35, 103.82], size: '10px', color: '#4A90E2', bold: true },
  { name: 'JOHOR', pos: [1.55, 103.75], size: '9px', color: '#4a6fa5' },
  { name: 'MALAYSIA', pos: [3.5, 102.5], size: '11px', color: '#4a6fa5' },
  { name: 'SUMATRA', pos: [1.5, 101.0], size: '10px', color: '#4a6fa5' },
  { name: 'BATAM', pos: [1.12, 104.08], size: '8px', color: '#4a6fa5' },
  { name: 'BINTAN', pos: [1.13, 104.43], size: '8px', color: '#4a6fa5' },
  { name: 'KARIMUN', pos: [1.08, 103.42], size: '7px', color: '#4a6fa5' },
  { name: 'BORNEO', pos: [1.5, 110.5], size: '10px', color: '#4a6fa5' },
  { name: 'P. TEKONG', pos: [1.40, 104.05], size: '7px', color: '#4A90E2' },
];

// H5: Military bases data
const MILITARY_BASES = [
  // Singapore
  { name: 'Changi Air Base', lat: 1.3644, lng: 103.9915, country: 'SG', type: 'airbase' },
  { name: 'Paya Lebar AB', lat: 1.3604, lng: 103.9100, country: 'SG', type: 'airbase' },
  { name: 'Tengah AB', lat: 1.3871, lng: 103.7091, country: 'SG', type: 'airbase' },
  { name: 'Sembawang AB', lat: 1.4153, lng: 103.8130, country: 'SG', type: 'airbase' },
  { name: 'Changi Naval Base', lat: 1.3270, lng: 104.0089, country: 'SG', type: 'naval' },
  // Malaysia
  { name: 'RMAF Butterworth', lat: 5.4664, lng: 100.3907, country: 'MY', type: 'airbase' },
  { name: 'Senai', lat: 1.6413, lng: 103.6699, country: 'MY', type: 'airbase' },
  // Indonesia
  { name: 'Hang Nadim Batam', lat: 1.1211, lng: 104.1191, country: 'ID', type: 'airbase' },
  { name: 'Tanjung Pinang', lat: 0.9217, lng: 104.5319, country: 'ID', type: 'airbase' },
  { name: 'Ranai Natuna', lat: 3.9087, lng: 108.3881, country: 'ID', type: 'airbase' },
];

// M18: Tile layer options
const TILE_LAYERS = {
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri',
    subdomains: '',
  },
  terrain: {
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenTopoMap',
    subdomains: 'abc',
  },
};

// M11: Default layer visibility
const DEFAULT_LAYERS = {
  rangeRings: true,
  borders: true,
  tssLanes: true,
  anchorageZones: true,
  labels: true,
  flightTrails: true,
  militaryBases: true,
  clustering: true,
  weather: false,
  heatmap: true,
  tssFlow: true,
  tradeRoutes: true,
  settlements: true,
  infrastructure: true,
  vesselTrails: false,
  annotations: true,
  newsEvents: false,
  thermalActivity: false,
};

function loadLayerSettings() {
  if (typeof window === 'undefined') return DEFAULT_LAYERS;
  try {
    const saved = localStorage.getItem('star-map-layers');
    if (saved) return { ...DEFAULT_LAYERS, ...JSON.parse(saved) };
  } catch (_) {}
  return DEFAULT_LAYERS;
}

function loadTileSetting() {
  if (typeof window === 'undefined') return 'dark';
  try {
    return localStorage.getItem('star-map-tile') || 'dark';
  } catch (_) {}
  return 'dark';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flip(coords) {
  return coords.map(([lng, lat]) => [lat, lng]);
}

// ---------------------------------------------------------------------------
// Custom SVG icon factories
// ---------------------------------------------------------------------------

function createShipIcon(heading, { isFlagged, isFocused, isSelected, selectedColor, vesselCategory, isSanctioned }) {
  const category = vesselCategory || 'default';
  const colorScheme = VESSEL_COLORS[category] || VESSEL_COLORS.default;
  const path = VESSEL_PATHS[category] || VESSEL_PATHS.default;

  const fill = isFocused ? '#fbbf24' : (isFlagged || isSanctioned) ? '#C8102E' : colorScheme.fill;
  const stroke = isFocused ? '#fde68a' : (isFlagged || isSanctioned) ? '#ff6b6b' : colorScheme.stroke;
  const sw = isFocused ? 2.5 : (isFlagged || isSanctioned) ? 1.5 : 0.8;
  const cls = isFocused ? 'vessel-icon focused-vessel' : isSanctioned ? 'vessel-icon sanctioned-vessel' : 'vessel-icon';
  const ring = isSelected
    ? `<circle cx="0" cy="0" r="12" fill="none" stroke="${selectedColor}" stroke-width="2" stroke-dasharray="3,2" opacity="0.8"/>`
    : '';
  // Sanctioned vessels get a pulsing red glow circle behind them
  const sanctionGlow = isSanctioned
    ? `<circle cx="0" cy="0" r="13" fill="#C8102E" fill-opacity="0.15" stroke="#ef4444" stroke-width="1.5" stroke-opacity="0.6"><animate attributeName="r" values="11;15;11" dur="1.5s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values="0.2;0.05;0.2" dur="1.5s" repeatCount="indefinite"/></circle>`
    : '';
  const html = `<svg width="32" height="32" viewBox="-16 -16 32 32" xmlns="http://www.w3.org/2000/svg">
    ${sanctionGlow}${ring}
    <g transform="rotate(${heading ?? 0},0,0)">
      <path d="${path}" fill="${fill}" fill-opacity="0.9" stroke="${stroke}" stroke-width="${sw}"/>
    </g></svg>`;
  return L.divIcon({ html, className: cls, iconSize: [32, 32], iconAnchor: [16, 16] });
}

function createPlaneIcon(heading, { isSelected, selectedColor } = {}) {
  const ring = isSelected
    ? `<circle cx="0" cy="0" r="14" fill="none" stroke="${selectedColor}" stroke-width="2" stroke-dasharray="3,2" opacity="0.8"/>`
    : '';
  const html = `<svg width="32" height="32" viewBox="-16 -16 32 32" xmlns="http://www.w3.org/2000/svg">
    ${ring}
    <g transform="rotate(${heading ?? 0},0,0)">
      <path d="${PLANE_PATH}" fill="#4A90E2" fill-opacity="0.9" stroke="#7BB3F0" stroke-width="0.8"/>
    </g></svg>`;
  return L.divIcon({ html, className: 'aircraft-icon', iconSize: [32, 32], iconAnchor: [16, 16] });
}

function createClusterIcon(cluster, type) {
  const count = cluster.getChildCount();
  const markers = cluster.getAllChildMarkers();
  const isVessel = type === 'vessel';
  const hasRisk = isVessel && markers.some(
    (m) => m.options.entityData?.flagged ||
      ['high', 'critical'].includes(m.options.entityData?.risk_level)
  );
  const baseColor = hasRisk ? '#C8102E' : isVessel ? '#003A70' : '#4A90E2';
  const r = Math.min(8 + count * 1.5, 24);
  const size = r * 2 + 6;
  const html = `<div style="width:${size}px;height:${size}px;position:relative;display:flex;align-items:center;justify-content:center;">
    <div style="position:absolute;inset:0;border-radius:50%;background:${baseColor}30;"></div>
    <div style="width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:#0a162890;border:1.5px solid ${baseColor};display:flex;align-items:center;justify-content:center;color:${baseColor};font-size:${count > 99 ? 8 : 10}px;font-family:monospace;font-weight:bold;">
      ${count}
    </div></div>`;
  return L.divIcon({ html, className: 'custom-cluster-icon', iconSize: [size, size] });
}

function createLabelIcon(label) {
  const html = `<span style="color:${label.color};font-size:${label.size};font-family:monospace;font-weight:${label.bold ? 'bold' : 'normal'};opacity:0.8;white-space:nowrap;">${label.name}</span>`;
  return L.divIcon({ html, className: 'region-label-icon', iconAnchor: [0, 0] });
}

// H5: Military base diamond icon
function createMilitaryBaseIcon(base) {
  const color = '#7C3AED';
  const html = `<svg width="16" height="16" viewBox="-8 -8 16 16" xmlns="http://www.w3.org/2000/svg">
    <path d="M0,-6 L6,0 L0,6 L-6,0 Z" fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-width="1"/>
    <circle cx="0" cy="0" r="1.5" fill="white" opacity="0.8"/>
  </svg>`;
  return L.divIcon({ html, className: 'military-base-icon', iconSize: [16, 16], iconAnchor: [8, 8] });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TheaterFlyTo({ center, zoom, maxBounds }) {
  const map = useMap();
  useEffect(() => {
    if (!center) return;
    map.flyTo(center, zoom || 9, { duration: 1.2 });
    if (maxBounds) {
      map.setMaxBounds(maxBounds);
    }
  }, [center, zoom, maxBounds, map]);
  return null;
}

function FocusHandler({ focusedMmsi, vessels }) {
  const map = useMap();
  useEffect(() => {
    if (!focusedMmsi) return;
    const target = vessels.find((v) => String(v.mmsi) === String(focusedMmsi));
    if (!target) return;
    const lat = target.latitude ?? target.lat;
    const lng = target.longitude ?? target.lon;
    if (lat == null || lng == null) return;
    map.flyTo([lat, lng], 13, { duration: 0.8 });
  }, [focusedMmsi, vessels, map]);
  return null;
}

// H5: Track zoom level for military base visibility
function ZoomTracker({ onZoomChange }) {
  useMapEvents({
    zoomend: (e) => {
      onZoomChange(e.target.getZoom());
    },
  });
  return null;
}

function RangeRings() {
  return (
    <>
      {RANGE_RINGS_KM.map((km) => (
        <Circle
          key={km}
          center={SINGAPORE_CENTER}
          radius={km * 1000}
          pathOptions={{ fill: false, color: '#1e3a5f', weight: 0.5, dashArray: '6,4' }}
        >
          <Tooltip permanent direction="right" className="range-label">
            {km}km
          </Tooltip>
        </Circle>
      ))}
      <Circle
        center={SINGAPORE_CENTER}
        radius={500}
        pathOptions={{ fill: false, color: 'transparent', weight: 0 }}
      >
        <Marker
          position={SINGAPORE_CENTER}
          icon={L.divIcon({
            html: '<div style="width:8px;height:8px;border-radius:50%;background:#003A70;opacity:0.5;border:1.5px solid #4A90E2;"></div>',
            className: 'sg-dot',
            iconSize: [8, 8],
            iconAnchor: [4, 4],
          })}
          interactive={false}
        />
      </Circle>
    </>
  );
}

function MaritimeBordersLayer() {
  return (
    <>
      {MARITIME_BORDERS.map((border) => {
        const positions = flip(border.coords);
        const mid = positions[Math.floor(positions.length / 2)];
        return (
          <Polyline
            key={border.name}
            positions={positions}
            pathOptions={{ color: '#ffffff20', weight: 1.5, dashArray: '8,6' }}
          >
            <Tooltip permanent position={mid} direction="top" className="border-label">
              {border.name}
            </Tooltip>
          </Polyline>
        );
      })}
    </>
  );
}

function TSSLanesLayer() {
  return (
    <>
      {TSS_LANES.map((lane) => {
        const positions = flip(lane.coords);
        const isSep = lane.name === 'Separation Zone';
        return (
          <span key={lane.name}>
            <Polyline
              positions={positions}
              pathOptions={{ color: lane.color, weight: isSep ? 2 : 12, lineCap: 'round' }}
            />
            <Polyline
              positions={positions}
              pathOptions={{
                color: lane.stroke,
                weight: 0.8,
                dashArray: isSep ? '2,4' : '6,4',
                opacity: 0.6,
              }}
            >
              {lane.arrow && (
                <Tooltip permanent direction="top" className="tss-label">
                  {lane.arrow} {lane.name}
                </Tooltip>
              )}
            </Polyline>
          </span>
        );
      })}
    </>
  );
}

function AnchorageZonesLayer() {
  return (
    <>
      {ZONES.map((zone) => {
        const positions = flip(zone.coords);
        return (
          <Polygon
            key={zone.name}
            positions={positions}
            pathOptions={{
              fillColor: '#6366f120',
              color: '#6366f1',
              weight: 0.5,
              dashArray: '3,3',
            }}
          >
            <Tooltip permanent direction="center" className="zone-label">
              {zone.name}
            </Tooltip>
          </Polygon>
        );
      })}
    </>
  );
}

function RegionLabels() {
  const icons = useMemo(
    () => LABELS.map((label) => ({ ...label, icon: createLabelIcon(label) })),
    []
  );
  return (
    <>
      {icons.map((label) => (
        <Marker
          key={label.name}
          position={label.pos}
          icon={label.icon}
          interactive={false}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// DJINN Theater Overlays (Strait of Hormuz)
// ---------------------------------------------------------------------------

const DJINN_CENTER = [26.25, 56.25];
const DJINN_RANGE_RINGS_KM = [50, 100, 200];

const DJINN_TSS_LANES = [
  {
    name: 'Inbound Lane (into Gulf)',
    color: '#22d3ee40',
    stroke: '#22d3ee',
    arrow: '\u2192',
    coords: [
      [56.0, 26.275], [56.1, 26.28], [56.2, 26.285], [56.3, 26.29],
      [56.4, 26.295], [56.5, 26.30],
    ],
  },
  {
    name: 'Outbound Lane (from Gulf)',
    color: '#f9731640',
    stroke: '#f97316',
    arrow: '\u2190',
    coords: [
      [56.5, 26.525], [56.4, 26.52], [56.3, 26.515], [56.2, 26.51],
      [56.1, 26.505], [56.0, 26.50],
    ],
  },
  {
    name: 'Separation Zone',
    color: '#fbbf2420',
    stroke: '#fbbf24',
    coords: [
      [56.0, 26.39], [56.1, 26.39], [56.2, 26.40], [56.3, 26.40],
      [56.4, 26.41], [56.5, 26.41],
    ],
  },
];

const DJINN_IRANIAN_TW = [
  [56.0, 27.0], [56.5, 26.7], [57.0, 26.6], [57.5, 26.5],
];

const DJINN_OMANI_WATERS = [
  [56.0, 26.2], [56.3, 26.15], [56.5, 26.3],
];

const DJINN_PORTS = [
  { name: 'Bandar Abbas', lat: 27.17, lng: 56.28, color: '#ef4444', country: 'Iran' },
  { name: 'Fujairah', lat: 25.13, lng: 56.33, color: '#3b82f6', country: 'UAE' },
  { name: 'Khor Fakkan', lat: 25.35, lng: 56.36, color: '#3b82f6', country: 'UAE' },
  { name: 'Jebel Ali', lat: 25.01, lng: 55.06, color: '#3b82f6', country: 'UAE' },
  { name: 'Muscat', lat: 23.61, lng: 58.59, color: '#22c55e', country: 'Oman' },
];

const DJINN_NAVAL_BASES = [
  { name: 'US NSA Bahrain', lat: 26.23, lng: 50.65 },
  { name: 'Bandar Abbas Naval Base', lat: 27.15, lng: 56.30 },
  { name: 'Abu Musa Island IRGCN', lat: 25.87, lng: 55.03 },
  { name: 'Greater Tunb Island', lat: 26.27, lng: 55.28 },
  { name: 'Lesser Tunb Island', lat: 26.23, lng: 55.14 },
  { name: 'Farsi Island IRGCN', lat: 27.03, lng: 53.93 },
  { name: 'Larak Island IRGCN', lat: 26.85, lng: 56.35 },
];

const DJINN_OIL_TERMINALS = [
  { name: 'Kharg Island', lat: 29.23, lng: 50.32 },
  { name: 'Ras Tanura', lat: 26.64, lng: 50.17 },
  { name: 'Fujairah Oil Terminal', lat: 25.11, lng: 56.36 },
  { name: 'Mina Al Ahmadi', lat: 29.05, lng: 48.17 },
];

const DJINN_STS_HOTSPOTS = [
  { name: 'Fujairah Outer Anchorage', lat: 25.20, lng: 56.40 },
  { name: 'Khorfakkan Roads', lat: 25.35, lng: 56.40 },
  { name: 'UAE-Oman Border Waters', lat: 25.30, lng: 56.50 },
];

const DJINN_ANCHORAGE_ZONES = [
  {
    name: 'Fujairah Anchorage',
    coords: [[56.20, 25.05], [56.50, 25.05], [56.50, 25.25], [56.20, 25.25], [56.20, 25.05]],
  },
  {
    name: 'Khorfakkan Anchorage',
    coords: [[56.30, 25.30], [56.45, 25.30], [56.45, 25.40], [56.30, 25.40], [56.30, 25.30]],
  },
];

const DJINN_LABELS = [
  { name: 'IRAN', pos: [27.5, 55.5], size: '11px', color: '#ef4444', bold: true },
  { name: 'OMAN', pos: [23.8, 57.5], size: '11px', color: '#22c55e', bold: true },
  { name: 'UAE', pos: [25.0, 54.5], size: '11px', color: '#3b82f6', bold: true },
  { name: 'MUSANDAM', pos: [26.15, 56.3], size: '9px', color: '#22c55e' },
  { name: 'QESHM ISLAND', pos: [26.85, 56.0], size: '8px', color: '#ef4444' },
  { name: 'HORMUZ ISLAND', pos: [27.05, 56.45], size: '8px', color: '#ef4444' },
  { name: 'LARAK ISLAND', pos: [26.85, 56.40], size: '7px', color: '#ef4444' },
];

// ---------------------------------------------------------------------------
// DJINN: Coastal Settlements (Item: Visual Enrichment)
// Population-scaled circle markers with labels visible at zoom >= 8
// ---------------------------------------------------------------------------

const DJINN_SETTLEMENTS = [
  // Iran coast
  { name: 'Bandar Abbas', lat: 27.19, lng: 56.28, pop: 500000, country: 'IR' },
  { name: 'Bandar Lengeh', lat: 26.56, lng: 54.88, pop: 25000, country: 'IR' },
  { name: 'Jask', lat: 25.64, lng: 57.77, pop: 15000, country: 'IR' },
  { name: 'Chabahar', lat: 25.29, lng: 60.64, pop: 100000, country: 'IR' },
  { name: 'Qeshm Town', lat: 26.95, lng: 56.27, pop: 30000, country: 'IR' },
  { name: 'Hormuz Town', lat: 27.06, lng: 56.46, pop: 6000, country: 'IR' },
  // UAE coast
  { name: 'Dubai', lat: 25.20, lng: 55.27, pop: 3500000, country: 'AE' },
  { name: 'Abu Dhabi', lat: 24.45, lng: 54.65, pop: 1500000, country: 'AE' },
  { name: 'Sharjah', lat: 25.34, lng: 55.41, pop: 1400000, country: 'AE' },
  { name: 'Ras Al Khaimah', lat: 25.79, lng: 55.94, pop: 350000, country: 'AE' },
  { name: 'Fujairah', lat: 25.13, lng: 56.33, pop: 150000, country: 'AE' },
  // Oman
  { name: 'Muscat', lat: 23.59, lng: 58.54, pop: 800000, country: 'OM' },
  { name: 'Khasab', lat: 26.18, lng: 56.25, pop: 18000, country: 'OM' },
  { name: 'Sohar', lat: 24.36, lng: 56.73, pop: 140000, country: 'OM' },
  // Qatar / Bahrain
  { name: 'Doha', lat: 25.29, lng: 51.53, pop: 2000000, country: 'QA' },
  { name: 'Manama', lat: 26.22, lng: 50.59, pop: 400000, country: 'BH' },
  // Saudi
  { name: 'Dammam', lat: 26.43, lng: 50.10, pop: 1000000, country: 'SA' },
];

// ---------------------------------------------------------------------------
// DJINN: Oil/Gas Infrastructure markers
// ---------------------------------------------------------------------------

const DJINN_INFRASTRUCTURE = [
  // Oil refineries
  { name: 'Ras Tanura Refinery', lat: 26.64, lng: 50.17, type: 'refinery' },
  { name: 'Jubail Industrial', lat: 27.01, lng: 49.66, type: 'refinery' },
  { name: 'Ruwais Refinery', lat: 24.11, lng: 52.73, type: 'refinery' },
  { name: 'Jebel Ali Refinery', lat: 25.01, lng: 55.06, type: 'refinery' },
  // LNG terminals
  { name: 'Ras Laffan LNG', lat: 25.93, lng: 51.53, type: 'lng' },
  { name: 'Das Island LNG', lat: 25.15, lng: 52.87, type: 'lng' },
  // Offshore platforms (approximate)
  { name: 'Safaniya Platform', lat: 28.20, lng: 48.90, type: 'platform' },
  { name: 'Marjan Platform', lat: 27.60, lng: 49.50, type: 'platform' },
  { name: 'Zakum Platform', lat: 24.85, lng: 53.80, type: 'platform' },
  { name: 'Umm Shaif Platform', lat: 25.05, lng: 52.60, type: 'platform' },
  { name: 'Fateh Platform', lat: 25.25, lng: 54.85, type: 'platform' },
  { name: 'Sirri Island Platform', lat: 25.88, lng: 54.55, type: 'platform' },
];

const DJINN_TRADE_ROUTES = [
  {
    name: 'Persian Gulf Inbound',
    color: '#3b82f6',
    coords: [[25.3, 56.8], [26.3, 56.4], [26.5, 56.0], [26.8, 55.0], [27.0, 53.0]],
  },
  {
    name: 'Persian Gulf Outbound',
    color: '#f97316',
    coords: [[27.0, 53.0], [26.8, 55.0], [26.5, 56.1], [26.2, 56.5], [25.3, 57.0]],
  },
  {
    name: 'Bandar Abbas Approach',
    color: '#ef4444',
    coords: [[26.6, 56.2], [27.17, 56.28]],
  },
  {
    name: 'Fujairah Approach',
    color: '#22d3ee',
    coords: [[25.5, 56.8], [25.13, 56.33]],
  },
  {
    name: 'Iran-East Corridor',
    color: '#eab308',
    coords: [[27.17, 56.28], [26.5, 57.5], [25.5, 58.5]],
  },
];

function DjinnTradeRoutes() {
  return (
    <>
      {DJINN_TRADE_ROUTES.map((route) => (
        <Polyline
          key={route.name}
          positions={route.coords}
          pathOptions={{
            color: route.color,
            weight: 2,
            opacity: 0.4,
            dashArray: '10, 8',
          }}
        >
          <Tooltip sticky>{route.name}</Tooltip>
        </Polyline>
      ))}
    </>
  );
}

function createPortIcon(port) {
  const html = `<svg width="14" height="14" viewBox="-7 -7 14 14" xmlns="http://www.w3.org/2000/svg">
    <circle cx="0" cy="0" r="5" fill="${port.color}" fill-opacity="0.7" stroke="${port.color}" stroke-width="1.5"/>
    <circle cx="0" cy="0" r="1.5" fill="white" opacity="0.9"/>
  </svg>`;
  return L.divIcon({ html, className: 'djinn-port-icon', iconSize: [14, 14], iconAnchor: [7, 7] });
}

function createOilTerminalIcon() {
  const html = `<svg width="14" height="14" viewBox="-7 -7 14 14" xmlns="http://www.w3.org/2000/svg">
    <rect x="-5" y="-5" width="10" height="10" rx="1.5" fill="#d97706" fill-opacity="0.7" stroke="#f59e0b" stroke-width="1"/>
    <circle cx="0" cy="0" r="1.5" fill="white" opacity="0.9"/>
  </svg>`;
  return L.divIcon({ html, className: 'djinn-oil-icon', iconSize: [14, 14], iconAnchor: [7, 7] });
}

function createStsHotspotIcon() {
  const html = `<svg width="16" height="16" viewBox="-8 -8 16 16" xmlns="http://www.w3.org/2000/svg">
    <polygon points="0,-6 5.2,3 -5.2,3" fill="#d97706" fill-opacity="0.6" stroke="#f59e0b" stroke-width="1.2"/>
    <text x="0" y="1" fill="white" font-size="6" font-family="monospace" font-weight="bold" text-anchor="middle" dominant-baseline="middle">!</text>
  </svg>`;
  return L.divIcon({ html, className: 'djinn-sts-icon', iconSize: [16, 16], iconAnchor: [8, 8] });
}

function DjinnRangeRings() {
  return (
    <>
      {DJINN_RANGE_RINGS_KM.map((km) => (
        <Circle
          key={`djinn-rr-${km}`}
          center={DJINN_CENTER}
          radius={km * 1000}
          pathOptions={{ fill: false, color: '#1e3a5f', weight: 0.5, dashArray: '6,4' }}
        >
          <Tooltip permanent direction="right" className="range-label">
            {km}km
          </Tooltip>
        </Circle>
      ))}
      <Marker
        position={DJINN_CENTER}
        icon={L.divIcon({
          html: '<div style="width:8px;height:8px;border-radius:50%;background:#003A70;opacity:0.5;border:1.5px solid #4A90E2;"></div>',
          className: 'djinn-center-dot',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        })}
        interactive={false}
      />
    </>
  );
}

function DjinnTSSLanes() {
  return (
    <>
      {DJINN_TSS_LANES.map((lane) => {
        const positions = flip(lane.coords);
        const isSep = lane.name === 'Separation Zone';
        return (
          <span key={lane.name}>
            <Polyline
              positions={positions}
              pathOptions={{ color: lane.color, weight: isSep ? 2 : 12, lineCap: 'round' }}
            />
            <Polyline
              positions={positions}
              pathOptions={{
                color: lane.stroke,
                weight: 0.8,
                dashArray: isSep ? '2,4' : '6,4',
                opacity: 0.6,
              }}
            >
              {lane.arrow && (
                <Tooltip permanent direction="top" className="tss-label">
                  {lane.arrow} {lane.name}
                </Tooltip>
              )}
            </Polyline>
          </span>
        );
      })}
    </>
  );
}

function DjinnBorders() {
  const iranPositions = DJINN_IRANIAN_TW.map(([lng, lat]) => [lat, lng]);
  const omanPositions = DJINN_OMANI_WATERS.map(([lng, lat]) => [lat, lng]);
  const iranMid = iranPositions[Math.floor(iranPositions.length / 2)];
  const omanMid = omanPositions[Math.floor(omanPositions.length / 2)];

  return (
    <>
      <Polyline
        positions={iranPositions}
        pathOptions={{ color: '#ef444480', weight: 1.5, dashArray: '8,6' }}
      >
        <Tooltip permanent position={iranMid} direction="top" className="border-label">
          IRANIAN TERRITORIAL WATERS
        </Tooltip>
      </Polyline>
      <Polyline
        positions={omanPositions}
        pathOptions={{ color: '#ffffff40', weight: 1.5, dashArray: '8,6' }}
      >
        <Tooltip permanent position={omanMid} direction="top" className="border-label">
          OMANI WATERS (MUSANDAM)
        </Tooltip>
      </Polyline>
    </>
  );
}

function DjinnPorts() {
  return (
    <>
      {DJINN_PORTS.map((port) => (
        <Marker
          key={port.name}
          position={[port.lat, port.lng]}
          icon={createPortIcon(port)}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: port.color }}>{port.name}</div>
              <div>{port.country}</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

function DjinnNavalBases({ zoom }) {
  const icons = useMemo(
    () => DJINN_NAVAL_BASES.map((base) => ({ ...base, icon: createMilitaryBaseIcon(base) })),
    []
  );

  if (zoom < 7) return null;

  return (
    <>
      {icons.map((base) => (
        <Marker
          key={base.name}
          position={[base.lat, base.lng]}
          icon={base.icon}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: '#7C3AED' }}>{base.name}</div>
              <div>Naval / Military Base</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

function DjinnOilTerminals() {
  const icons = useMemo(
    () => DJINN_OIL_TERMINALS.map((t) => ({ ...t, icon: createOilTerminalIcon() })),
    []
  );

  return (
    <>
      {icons.map((t) => (
        <Marker
          key={t.name}
          position={[t.lat, t.lng]}
          icon={t.icon}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: '#d97706' }}>{t.name}</div>
              <div>Oil Terminal</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

function DjinnStsHotspots() {
  const icons = useMemo(
    () => DJINN_STS_HOTSPOTS.map((h) => ({ ...h, icon: createStsHotspotIcon() })),
    []
  );

  return (
    <>
      {icons.map((h) => (
        <Marker
          key={h.name}
          position={[h.lat, h.lng]}
          icon={h.icon}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: '#f59e0b' }}>{h.name}</div>
              <div>STS Transfer Hotspot</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

function DjinnAnchorageZones() {
  return (
    <>
      {DJINN_ANCHORAGE_ZONES.map((zone) => {
        const positions = flip(zone.coords);
        return (
          <Polygon
            key={zone.name}
            positions={positions}
            pathOptions={{
              fillColor: '#6366f120',
              color: '#6366f1',
              weight: 0.5,
              dashArray: '3,3',
            }}
          >
            <Tooltip permanent direction="center" className="zone-label">
              {zone.name}
            </Tooltip>
          </Polygon>
        );
      })}
    </>
  );
}

function DjinnLabels() {
  const icons = useMemo(
    () => DJINN_LABELS.map((label) => ({ ...label, icon: createLabelIcon(label) })),
    []
  );
  return (
    <>
      {icons.map((label) => (
        <Marker
          key={label.name}
          position={label.pos}
          icon={label.icon}
          interactive={false}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// DJINN: Coastal Settlements layer (Natural Earth style)
// Population-scaled circle markers with labels at zoom >= 8
// ---------------------------------------------------------------------------

const SETTLEMENT_COUNTRY_COLORS = {
  IR: '#ef4444', AE: '#3b82f6', OM: '#22c55e', QA: '#eab308', BH: '#f59e0b', SA: '#a855f7',
};

function DjinnSettlements({ zoom }) {
  if (zoom < 6) return null;

  return (
    <>
      {DJINN_SETTLEMENTS.map((s) => {
        const radius = Math.max(3, Math.log10(s.pop) * 2.5);
        const color = SETTLEMENT_COUNTRY_COLORS[s.country] || '#9ca3af';
        const showLabel = zoom >= 8 || s.pop >= 500000;
        return (
          <CircleMarker
            key={s.name}
            center={[s.lat, s.lng]}
            radius={radius}
            pathOptions={{
              color: '#ffffff',
              weight: 1,
              fillColor: '#9ca3af',
              fillOpacity: 0.6,
              opacity: 0.8,
            }}
          >
            {showLabel && (
              <Tooltip permanent direction="right" offset={[radius + 2, 0]} className="settlement-label">
                <span style={{ color, fontSize: s.pop >= 500000 ? '9px' : '8px', fontFamily: 'monospace', fontWeight: s.pop >= 1000000 ? 'bold' : 'normal' }}>
                  {s.name}
                </span>
              </Tooltip>
            )}
            {!showLabel && (
              <Tooltip direction="top" offset={[0, -6]}>
                <div className="font-mono text-xs">
                  <div className="font-bold" style={{ color }}>{s.name}</div>
                  <div>Pop: ~{s.pop >= 1000000 ? `${(s.pop / 1000000).toFixed(1)}M` : `${(s.pop / 1000).toFixed(0)}K`}</div>
                </div>
              </Tooltip>
            )}
          </CircleMarker>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// DJINN: Oil/Gas Infrastructure layer
// Amber/orange diamond markers for refineries, LNG terminals, offshore platforms
// ---------------------------------------------------------------------------

function createInfrastructureIcon(item) {
  const size = item.type === 'platform' ? 10 : 14;
  const half = size / 2;
  const label = item.type === 'lng' ? 'L' : item.type === 'platform' ? 'P' : 'R';
  const html = `<svg width="${size}" height="${size}" viewBox="-${half} -${half} ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <polygon points="0,-${half - 1} ${half - 1},0 0,${half - 1} -${half - 1},0" fill="#d97706" fill-opacity="0.7" stroke="#f59e0b" stroke-width="1"/>
    <text x="0" y="0.5" fill="white" font-size="${size - 5}" font-family="monospace" font-weight="bold" text-anchor="middle" dominant-baseline="middle">${label}</text>
  </svg>`;
  return L.divIcon({ html, className: 'djinn-infra-icon', iconSize: [size, size], iconAnchor: [half, half] });
}

function DjinnInfrastructure({ zoom }) {
  const icons = useMemo(
    () => DJINN_INFRASTRUCTURE.map((item) => ({ ...item, icon: createInfrastructureIcon(item) })),
    []
  );

  if (zoom < 7) return null;

  return (
    <>
      {icons.map((item) => (
        <Marker
          key={item.name}
          position={[item.lat, item.lng]}
          icon={item.icon}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: '#f59e0b' }}>{item.name}</div>
              <div>{item.type === 'refinery' ? 'Oil Refinery' : item.type === 'lng' ? 'LNG Terminal' : 'Offshore Platform'}</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// DJINN: Vessel Breadcrumb Trails
// Fading polyline trails showing last N positions per vessel
// ---------------------------------------------------------------------------

const DjinnVesselTrails = memo(function DjinnVesselTrails({ vessels }) {
  // Build trail segments from vessel position history (stored in vessel._trail or vessel.trail)
  const trails = useMemo(() => {
    const result = [];
    for (const v of vessels) {
      const trail = v._trail || v.trail || v.positions;
      if (!trail || trail.length < 2) continue;
      // Build segments with decreasing opacity
      const total = trail.length;
      const segments = [];
      for (let i = 0; i < total - 1; i++) {
        const p1 = trail[i];
        const p2 = trail[i + 1];
        const lat1 = p1.lat ?? p1.latitude ?? p1[0];
        const lng1 = p1.lng ?? p1.longitude ?? p1[1];
        const lat2 = p2.lat ?? p2.latitude ?? p2[0];
        const lng2 = p2.lng ?? p2.longitude ?? p2[1];
        if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) continue;
        const opacity = 0.1 + (i / total) * 0.7;
        segments.push({ positions: [[lat1, lng1], [lat2, lng2]], opacity });
      }
      if (segments.length > 0) {
        const isFlagged = v.flagged === 1 || v.risk_level === 'high' || v.risk_level === 'critical';
        result.push({ mmsi: v.mmsi, segments, isFlagged });
      }
    }
    return result;
  }, [vessels]);

  if (trails.length === 0) return null;

  return (
    <>
      {trails.map((trail) =>
        trail.segments.map((seg, i) => (
          <Polyline
            key={`trail-${trail.mmsi}-${i}`}
            positions={seg.positions}
            pathOptions={{
              color: trail.isFlagged ? '#ef4444' : '#4A90E2',
              weight: 1.5,
              opacity: seg.opacity,
              dashArray: trail.isFlagged ? '' : '4,3',
            }}
          />
        ))
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// DJINN: Auto-generated Annotations
// Contextual text annotations for sanctions matches & STS alerts
// ---------------------------------------------------------------------------

function DjinnAnnotations({ vessels, alerts, zoom }) {
  if (zoom < 9) return null;

  const annotations = useMemo(() => {
    const result = [];

    // Sanctioned vessel annotations
    for (const v of vessels) {
      if (v.flagged === 1 || v.flagged === true) {
        const lat = v.latitude ?? v.lat;
        const lng = v.longitude ?? v.lon;
        if (lat != null && lng != null) {
          result.push({
            key: `sanc-${v.mmsi}`,
            lat: lat + 0.02,
            lng,
            text: 'SANCTIONS MATCH',
            color: '#ef4444',
            bgColor: 'rgba(239,68,68,0.15)',
          });
        }
      }
    }

    // STS transfer alert annotations
    if (alerts && alerts.length > 0) {
      for (const a of alerts) {
        const isSts = (a.type || '').toLowerCase().includes('sts') ||
                      (a.message || '').toLowerCase().includes('ship-to-ship') ||
                      (a.message || '').toLowerCase().includes('sts transfer');
        if (isSts && a.latitude != null && a.longitude != null) {
          result.push({
            key: `sts-${a.id || a.latitude}`,
            lat: a.latitude + 0.02,
            lng: a.longitude,
            text: 'STS TRANSFER',
            color: '#f59e0b',
            bgColor: 'rgba(245,158,11,0.15)',
          });
        }
      }
    }

    return result;
  }, [vessels, alerts]);

  if (annotations.length === 0) return null;

  return (
    <>
      {annotations.map((ann) => (
        <Marker
          key={ann.key}
          position={[ann.lat, ann.lng]}
          icon={L.divIcon({
            html: `<div style="
              font-family: monospace;
              font-size: 9px;
              font-weight: bold;
              color: ${ann.color};
              background: ${ann.bgColor};
              border: 1px solid ${ann.color}40;
              border-radius: 3px;
              padding: 1px 4px;
              white-space: nowrap;
              backdrop-filter: blur(2px);
            ">${ann.text}</div>`,
            className: 'djinn-annotation-icon',
            iconSize: null,
            iconAnchor: [40, 10],
          })}
          interactive={false}
        />
      ))}
    </>
  );
}

// H5: Military bases overlay
function MilitaryBasesLayer({ zoom }) {
  const icons = useMemo(
    () => MILITARY_BASES.map((base) => ({ ...base, icon: createMilitaryBaseIcon(base) })),
    []
  );

  if (zoom < 8) return null;

  return (
    <>
      {icons.map((base) => (
        <Marker
          key={base.name}
          position={[base.lat, base.lng]}
          icon={base.icon}
        >
          <Tooltip direction="top" offset={[0, -8]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: '#7C3AED' }}>{base.name}</div>
              <div>{base.type === 'naval' ? 'Naval Base' : 'Air Base'} ({base.country})</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Live flight trails
// ---------------------------------------------------------------------------

const FlightTrails = memo(function FlightTrails({ flightTrails }) {
  const segments = useMemo(() => {
    const result = [];
    const entries = Object.entries(flightTrails || {});
    for (const [callsign, positions] of entries) {
      if (!positions || positions.length < 2) continue;
      const total = positions.length - 1;
      for (let i = 0; i < total; i++) {
        const p1 = positions[i];
        const p2 = positions[i + 1];
        if (p1.lat == null || p1.lon == null || p2.lat == null || p2.lon == null) continue;
        const opacity = 0.15 + (i / total) * 0.45;
        result.push({
          key: `${callsign}-${i}`,
          positions: [[p1.lat, p1.lon], [p2.lat, p2.lon]],
          opacity,
        });
      }
    }
    return result;
  }, [flightTrails]);

  return (
    <>
      {segments.map((seg) => (
        <Polyline
          key={seg.key}
          positions={seg.positions}
          pathOptions={{ color: '#4A90E2', weight: 1.5, opacity: seg.opacity }}
          interactive={false}
        />
      ))}
    </>
  );
});

// ---------------------------------------------------------------------------
// Weather helpers
function rainfallColor(value) {
  if (value == null || value === 0) return '#22c55e';
  if (value <= 2) return '#3b82f6';
  if (value <= 10) return '#eab308';
  if (value <= 30) return '#f97316';
  return '#ef4444';
}

function rainfallRadius(value) {
  if (value == null || value === 0) return 3;
  if (value <= 2) return 4;
  if (value <= 10) return 6;
  if (value <= 30) return 8;
  return 10;
}

function createWindArrowIcon(directionDeg) {
  const rot = directionDeg ?? 0;
  const html = `<svg width="20" height="20" viewBox="-10 -10 20 20" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${rot},0,0)">
      <line x1="0" y1="6" x2="0" y2="-6" stroke="#60A5FA" stroke-width="1.5"/>
      <polygon points="0,-7 -3,-3 3,-3" fill="#60A5FA"/>
    </g></svg>`;
  return L.divIcon({ html, className: 'wind-arrow-icon', iconSize: [20, 20], iconAnchor: [10, 10] });
}

function createForecastLabelIcon(text) {
  const html = `<span style="color:#93c5fd;font-size:8px;font-family:monospace;white-space:nowrap;background:rgba(10,22,40,0.7);padding:1px 3px;border-radius:2px;">${text}</span>`;
  return L.divIcon({ html, className: 'forecast-label-icon', iconAnchor: [0, 0] });
}

// Weather overlay — NEA station data (rainfall, wind, forecast)
const WeatherOverlay = memo(function WeatherOverlay({ neaWeather, zoom }) {
  if (!neaWeather) return null;
  const { rainfall = [], wind = [], forecast = [] } = neaWeather;

  const forecastIcons = useMemo(
    () => forecast.filter((f) => f.lat != null && f.lon != null).map((f) => ({ ...f, icon: createForecastLabelIcon(f.forecast) })),
    [forecast]
  );
  const windIcons = useMemo(
    () => wind.filter((w) => w.lat != null && w.lon != null).map((w) => ({ ...w, icon: createWindArrowIcon(w.direction_deg) })),
    [wind]
  );

  return (
    <>
      {rainfall.filter((r) => r.lat != null && r.lon != null).map((r) => (
        <CircleMarker key={`rain-${r.id}`} center={[r.lat, r.lon]} radius={rainfallRadius(r.value)}
          pathOptions={{ color: rainfallColor(r.value), fillColor: rainfallColor(r.value), fillOpacity: 0.6, weight: 1 }}>
          <Tooltip direction="top" offset={[0, -4]}>
            <div className="font-mono text-xs">
              <div className="font-bold" style={{ color: rainfallColor(r.value) }}>{r.name}</div>
              <div>Rainfall: {r.value != null ? `${r.value} mm` : 'N/A'}</div>
            </div>
          </Tooltip>
        </CircleMarker>
      ))}
      {windIcons.map((w) => (
        <Marker key={`wind-${w.id}`} position={[w.lat, w.lon]} icon={w.icon}>
          <Tooltip direction="top" offset={[0, -10]}>
            <div className="font-mono text-xs">
              <div className="font-bold text-[#60A5FA]">{w.name}</div>
              <div>Wind: {w.speed_kt != null ? `${w.speed_kt} kn` : 'N/A'}</div>
              <div>Direction: {w.direction_deg != null ? `${w.direction_deg}\u00b0` : 'N/A'}</div>
            </div>
          </Tooltip>
        </Marker>
      ))}
      {zoom >= 12 && forecastIcons.map((f) => (
        <Marker key={`fc-${f.area}`} position={[f.lat, f.lon]} icon={f.icon} interactive={false} />
      ))}
    </>
  );
});

// ---------------------------------------------------------------------------
// Multi-track overlay
// ---------------------------------------------------------------------------

function TrackOverlay({ tracksData, selectedEntities, playbackIndices }) {
  if (!tracksData || !(tracksData instanceof globalThis.Map) || tracksData.size === 0) return null;

  return (
    <>
      {selectedEntities.map((entity, idx) => {
        const id = entity.type === 'vessel' ? entity.mmsi : entity.callsign;
        const positions = tracksData.get(id);
        if (!positions || positions.length === 0) return null;

        const color = TRACK_COLORS[idx % TRACK_COLORS.length];
        const pbIdx = playbackIndices?.[id] ?? positions.length - 1;
        const clampedIdx = Math.min(pbIdx, positions.length - 1);

        const trailCoords = positions
          .slice(0, clampedIdx + 1)
          .filter((p) => p.lat != null && p.lon != null)
          .map((p) => [p.lat, p.lon]);

        const futureCoords = positions
          .slice(clampedIdx)
          .filter((p) => p.lat != null && p.lon != null)
          .map((p) => [p.lat, p.lon]);

        const currentPos = positions[clampedIdx];
        const hasPos = currentPos?.lat != null && currentPos?.lon != null;

        return (
          <span key={id}>
            {trailCoords.length > 1 && (
              <Polyline
                positions={trailCoords}
                pathOptions={{ color, weight: 2.5, opacity: 0.85 }}
              />
            )}
            {futureCoords.length > 1 && (
              <Polyline
                positions={futureCoords}
                pathOptions={{ color, weight: 1, opacity: 0.25, dashArray: '4,4' }}
              />
            )}
            {hasPos && (
              <CircleMarker
                center={[currentPos.lat, currentPos.lon]}
                radius={6}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.9,
                  weight: 2,
                }}
              >
                <Tooltip direction="top" offset={[0, -8]}>
                  <div className="font-mono text-xs">
                    <div style={{ color }} className="font-bold">
                      {entity.type === 'vessel'
                        ? (entity.name || entity.vessel_name || entity.mmsi)
                        : (entity.callsign || entity.flight_number)}
                    </div>
                    <div>Time: {currentPos.recorded_at || 'N/A'}</div>
                    {currentPos.speed_kt != null && <div>Speed: {currentPos.speed_kt} kn</div>}
                    {currentPos.heading != null && <div>Hdg: {Math.round(currentPos.heading)}&deg;</div>}
                    {currentPos.altitude_ft != null && <div>Alt: {Math.round(currentPos.altitude_ft).toLocaleString()} ft</div>}
                  </div>
                </Tooltip>
              </CircleMarker>
            )}
            {trailCoords.map((pos, i) => (
              <CircleMarker
                key={`${id}-dot-${i}`}
                center={pos}
                radius={1.5}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.5, weight: 0 }}
              />
            ))}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// DJINN: Vessel Density Heatmap (Item 17)
// Uses CircleMarkers with opacity/radius based on vessel count per grid cell
// ---------------------------------------------------------------------------

const DjinnHeatmap = memo(function DjinnHeatmap({ data }) {
  if (!data || data.length === 0) return null;

  const maxCount = Math.max(...data.map(d => d[2]), 1);

  return (
    <>
      {data.map(([lat, lon, count], i) => {
        const intensity = count / maxCount;
        const radius = 8 + intensity * 20;
        const opacity = 0.15 + intensity * 0.55;
        const color = intensity > 0.7 ? '#ef4444' : intensity > 0.4 ? '#f59e0b' : '#22d3ee';
        return (
          <CircleMarker
            key={`heat-${i}`}
            center={[lat, lon]}
            radius={radius}
            pathOptions={{
              color: color,
              fillColor: color,
              fillOpacity: opacity,
              weight: 0.5,
              opacity: opacity * 0.6,
            }}
          >
            <Tooltip direction="top">
              <div className="font-mono text-xs">
                <div className="font-bold" style={{ color }}>{count} vessel(s)</div>
                <div>{lat.toFixed(2)}, {lon.toFixed(2)}</div>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// DJINN: TSS Flow Direction Arrows (Item 21)
// Shows predominant vessel heading in each TSS lane with arrow markers
// ---------------------------------------------------------------------------

function createFlowArrowIcon(heading, vesselCount) {
  const thickness = Math.min(2 + vesselCount * 0.5, 6);
  const size = 32 + Math.min(vesselCount * 2, 20);
  const half = size / 2;
  const color = '#22d3ee';
  const html = `<svg width="${size}" height="${size}" viewBox="-${half} -${half} ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${heading || 0},0,0)">
      <line x1="0" y1="10" x2="0" y2="-10" stroke="${color}" stroke-width="${thickness}" opacity="0.8"/>
      <polygon points="0,-14 -5,-6 5,-6" fill="${color}" opacity="0.9"/>
    </g>
    <text x="0" y="${half - 4}" fill="#fff" font-size="9" font-family="monospace" font-weight="bold" text-anchor="middle" opacity="0.9">${vesselCount}</text>
  </svg>`;
  return L.divIcon({ html, className: 'tss-flow-arrow', iconSize: [size, size], iconAnchor: [half, half] });
}

const DjinnTSSFlowArrows = memo(function DjinnTSSFlowArrows({ data }) {
  if (!data) return null;

  const lanes = Object.entries(data).filter(([, v]) => v && v.vessel_count > 0);
  if (lanes.length === 0) return null;

  return (
    <>
      {lanes.map(([key, lane]) => {
        const midLat = (lane.lane.latMin + lane.lane.latMax) / 2;
        const midLon = (lane.lane.lonMin + lane.lane.lonMax) / 2;
        const icon = createFlowArrowIcon(lane.avg_heading, lane.vessel_count);

        // Draw lane boundary rectangle
        const bounds = [
          [lane.lane.latMin, lane.lane.lonMin],
          [lane.lane.latMin, lane.lane.lonMax],
          [lane.lane.latMax, lane.lane.lonMax],
          [lane.lane.latMax, lane.lane.lonMin],
        ];
        const laneColor = key === 'inbound' ? '#22d3ee' : '#f97316';

        return (
          <span key={key}>
            <Polygon
              positions={bounds}
              pathOptions={{ color: laneColor, fillColor: laneColor, fillOpacity: 0.05, weight: 1, dashArray: '4,4' }}
            />
            <Marker position={[midLat, midLon]} icon={icon} interactive={true}>
              <Tooltip direction="top" offset={[0, -20]}>
                <div className="font-mono text-xs">
                  <div className="font-bold" style={{ color: laneColor }}>{lane.lane.label}</div>
                  <div>{lane.vessel_count} vessel(s)</div>
                  <div>Avg heading: {lane.avg_heading != null ? `${lane.avg_heading}\u00b0` : 'N/A'}</div>
                </div>
              </Tooltip>
            </Marker>
          </span>
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// M18: Tile Layer Switcher (inside map)
// ---------------------------------------------------------------------------

function TileLayerSwitcher({ tileKey }) {
  const tile = TILE_LAYERS[tileKey] || TILE_LAYERS.dark;
  return (
    <TileLayer
      key={tileKey}
      url={tile.url}
      attribution={tile.attribution}
      subdomains={tile.subdomains || 'abcd'}
      maxZoom={20}
    />
  );
}

// ---------------------------------------------------------------------------
// DJINN: News Events Layer (GDELT OSINT articles)
// ---------------------------------------------------------------------------
function createNewsEventIcon() {
  const html = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="7" fill="#1E40AF" fill-opacity="0.8" stroke="#60A5FA" stroke-width="1.5"/>
    <text x="8" y="12" text-anchor="middle" fill="white" font-size="11" font-weight="bold">i</text>
  </svg>`;
  return L.divIcon({ html, className: 'news-event-icon', iconSize: [16, 16], iconAnchor: [8, 8] });
}

const DjinnNewsEvents = memo(function DjinnNewsEvents({ data = [] }) {
  // GDELT articles stored in intel_articles don't have lat/lon in the DB row,
  // but we can display them as a list-driven layer. For articles from GDELT source,
  // show markers if they have geo data, otherwise skip.
  // Since GDELT DOC API doesn't return coordinates directly, we show all GDELT
  // articles as a cluster at the Hormuz center with individual tooltips.
  // Future: use GDELT GEO API for actual coordinates.

  const gdeltArticles = useMemo(() => {
    return data.filter((a) => a.source === 'GDELT').slice(0, 50);
  }, [data]);

  if (gdeltArticles.length === 0) return null;

  // Spread articles in a grid pattern around Hormuz center for visibility
  const baseLatLon = [26.4, 56.3];

  const newsIcon = useMemo(() => createNewsEventIcon(), []);

  return (
    <>
      {gdeltArticles.map((article, i) => {
        // Offset each marker slightly to avoid stacking
        const row = Math.floor(i / 5);
        const col = i % 5;
        const lat = baseLatLon[0] + (row * 0.15) - 0.3;
        const lng = baseLatLon[1] + (col * 0.15) - 0.3;

        const dateStr = article.published_at
          ? new Date(article.published_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'Unknown';

        return (
          <Marker key={`news-${article.id || i}`} position={[lat, lng]} icon={newsIcon}>
            <Tooltip direction="top" offset={[0, -10]}>
              <div className="font-mono text-xs max-w-[250px]">
                <div className="font-bold text-blue-400 truncate">{article.title || 'Untitled'}</div>
                <div className="text-gray-300">Source: {article.source}</div>
                <div className="text-gray-400">{dateStr}</div>
                {article.link && (
                  <div className="text-blue-300 text-[9px] truncate">{article.link}</div>
                )}
              </div>
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// DJINN: Thermal Activity Layer (NASA FIRMS detections)
// ---------------------------------------------------------------------------
const DjinnThermalDetections = memo(function DjinnThermalDetections({ data = [] }) {
  if (!data || data.length === 0) return null;

  return (
    <>
      {data.map((d, i) => {
        if (d.lat == null || d.lon == null) return null;

        // Color based on confidence
        const color = d.confidence === 'high' ? '#EF4444'
          : d.confidence === 'nominal' ? '#F97316'
          : '#FBBF24';

        // Radius based on fire radiative power
        const frp = d.frp || 0;
        const radius = Math.max(3, Math.min(10, 3 + frp / 20));

        const dateStr = d.detected_at
          ? new Date(d.detected_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'Unknown';

        return (
          <CircleMarker
            key={`thermal-${d.id || i}`}
            center={[d.lat, d.lon]}
            radius={radius}
            pathOptions={{
              color: color,
              fillColor: color,
              fillOpacity: 0.7,
              weight: 1,
              opacity: 0.9,
            }}
          >
            <Tooltip direction="top" offset={[0, -5]}>
              <div className="font-mono text-xs">
                <div className="font-bold text-orange-400">Thermal Detection</div>
                <div>Brightness: {d.brightness?.toFixed(1) || 'N/A'} K</div>
                <div>Confidence: {d.confidence || 'N/A'}</div>
                <div>FRP: {d.frp?.toFixed(1) || 'N/A'} MW</div>
                <div>Satellite: {d.satellite || 'VIIRS'}</div>
                <div>Detected: {dateStr}</div>
                <div className="text-gray-400 text-[9px]">{d.lat?.toFixed(4)}, {d.lon?.toFixed(4)}</div>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// Main Map Component
// ---------------------------------------------------------------------------

export default function Map({
  vessels = [],
  flights = [],
  focusedMmsi = null,
  selectedEntities = [],
  tracksData,
  playbackIndices = {},
  onSelectEntity,
  flightTrails = {},
  neaWeather = null,
  theaterKey = 'merlion',
  center: propCenter,
  zoom: propZoom,
  maxBounds: propMaxBounds,
  heatmapData = [],
  tssFlowData = null,
  alerts = [],
  newsEvents = [],
  thermalData = [],
}) {
  const mapCenter = propCenter || SINGAPORE_CENTER;
  const mapInitZoom = propZoom || 9;
  const mapMaxBounds = propMaxBounds || [[-1.5, 99], [7.5, 108.5]];
  const isMerlion = theaterKey === 'merlion';
  const isDjinn = theaterKey === 'djinn';
  const [layers, setLayers] = useState(loadLayerSettings);
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  const [tileKey, setTileKey] = useState(loadTileSetting);
  const [zoom, setZoom] = useState(9);

  // Persist layer settings
  useEffect(() => {
    try { localStorage.setItem('star-map-layers', JSON.stringify(layers)); } catch (_) {}
  }, [layers]);

  useEffect(() => {
    try { localStorage.setItem('star-map-tile', tileKey); } catch (_) {}
  }, [tileKey]);

  const toggleLayer = (key) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectedIdSet = useMemo(() => {
    const map = new globalThis.Map();
    selectedEntities.forEach((e, idx) => {
      const id = e.type === 'vessel' ? e.mmsi : e.callsign;
      map.set(String(id), idx);
    });
    return map;
  }, [selectedEntities]);

  const vesselMarkers = useMemo(() => {
    return vessels
      .filter((v) => (v.latitude ?? v.lat) != null && (v.longitude ?? v.lon) != null)
      .map((v) => {
        const lat = v.latitude ?? v.lat;
        const lng = v.longitude ?? v.lon;
        const isSanctioned = v.flagged === 1 || v.flagged === true;
        const isFlagged = isSanctioned || v.risk_level === 'high' || v.risk_level === 'critical';
        const isFocused = focusedMmsi && String(v.mmsi) === String(focusedMmsi);
        const selIdx = selectedIdSet.get(String(v.mmsi));
        const isSelected = selIdx !== undefined;
        const selectedColor = isSelected ? TRACK_COLORS[selIdx % TRACK_COLORS.length] : null;
        const vesselCategory = getVesselCategory(v.ship_type || v.vessel_type);
        return { ...v, _lat: lat, _lng: lng, _isFlagged: isFlagged, _isSanctioned: isSanctioned, _isFocused: isFocused, _isSelected: isSelected, _selectedColor: selectedColor, _vesselCategory: vesselCategory };
      });
  }, [vessels, focusedMmsi, selectedIdSet]);

  const flightMarkers = useMemo(() => {
    return flights
      .filter((f) => (f.latitude ?? f.lat) != null && (f.longitude ?? f.lon) != null)
      .map((f) => {
        const lat = f.latitude ?? f.lat;
        const lng = f.longitude ?? f.lon;
        const cs = f.callsign || f.flight_number;
        const selIdx = selectedIdSet.get(String(cs));
        const isSelected = selIdx !== undefined;
        const selectedColor = isSelected ? TRACK_COLORS[selIdx % TRACK_COLORS.length] : null;
        return { ...f, _lat: lat, _lng: lng, _isSelected: isSelected, _selectedColor: selectedColor };
      });
  }, [flights, selectedIdSet]);

  // Vessel markers rendering (with or without clustering)
  const vesselMarkersJsx = vesselMarkers.map((v) => (
    <Marker
      key={v.mmsi}
      position={[v._lat, v._lng]}
      icon={createShipIcon(v.heading, { isFlagged: v._isFlagged, isFocused: v._isFocused, isSelected: v._isSelected, selectedColor: v._selectedColor, vesselCategory: v._vesselCategory, isSanctioned: v._isSanctioned })}
      entityData={v}
      eventHandlers={{
        click: () => onSelectEntity?.({ type: 'vessel', mmsi: v.mmsi, vessel_name: v.vessel_name || v.name, latitude: v._lat, longitude: v._lng }),
      }}
    >
      <Tooltip direction="top" offset={[0, -10]}>
        <div className="font-mono text-xs">
          <div className="font-bold text-[#4A90E2]">
            {v.name || v.vessel_name || 'Unknown'}
          </div>
          <div>MMSI: {v.mmsi || 'N/A'}</div>
          <div>Type: {v.ship_type || v.vessel_type || 'N/A'} ({v._vesselCategory})</div>
          <div>Speed: {v.speed_kt != null ? `${v.speed_kt} kn` : (v.speed != null ? `${v.speed} kn` : 'N/A')}</div>
          <div>Heading: {v.heading != null ? `${v.heading}\u00b0` : 'N/A'}</div>
          {v._isFlagged && (
            <div className="text-[#C8102E] font-bold">Risk: {v.risk_level || 'HIGH'}</div>
          )}
          {v._isSelected && (
            <div style={{ color: v._selectedColor }} className="font-bold mt-1">TRACKING</div>
          )}
        </div>
      </Tooltip>
    </Marker>
  ));

  const flightMarkersJsx = flightMarkers.map((f, i) => {
    const heading = f.heading ?? f.track ?? 0;
    return (
      <Marker
        key={f.callsign || f.flight_number || `flight-${i}`}
        position={[f._lat, f._lng]}
        icon={createPlaneIcon(heading, { isSelected: f._isSelected, selectedColor: f._selectedColor })}
        eventHandlers={{
          click: () => onSelectEntity?.({ type: 'flight', callsign: f.callsign, flight_number: f.flight_number, latitude: f._lat, longitude: f._lng }),
        }}
      >
        <Tooltip direction="top" offset={[0, -10]}>
          <div className="font-mono text-xs">
            <div className="font-bold text-[#4A90E2]">
              {f.callsign || f.flight_number || 'Unknown'}
            </div>
            <div>Altitude: {f.altitude_ft != null ? `${Math.round(f.altitude_ft).toLocaleString()} ft` : 'N/A'}</div>
            <div>Speed: {f.speed_kt != null ? `${Math.round(f.speed_kt)} kn` : 'N/A'}</div>
            <div>Heading: {Math.round(heading)}{'\u00b0'}</div>
            <div>Squawk: {f.squawk || 'N/A'}</div>
            {f._isSelected && (
              <div style={{ color: f._selectedColor }} className="font-bold mt-1">TRACKING</div>
            )}
          </div>
        </Tooltip>
      </Marker>
    );
  });

  const LAYER_OPTIONS = [
    { key: 'rangeRings', label: 'Range Rings' },
    { key: 'borders', label: 'Borders' },
    { key: 'tssLanes', label: 'TSS Lanes' },
    { key: 'anchorageZones', label: 'Anchorage Zones' },
    { key: 'labels', label: 'Labels' },
    { key: 'flightTrails', label: 'Flight Trails' },
    { key: 'militaryBases', label: 'Military Bases' },
    { key: 'clustering', label: 'Clustering' },
    { key: 'weather', label: 'Weather Stations' },
    ...(isDjinn ? [
      { key: 'settlements', label: 'Settlements' },
      { key: 'infrastructure', label: 'Infrastructure' },
      { key: 'vesselTrails', label: 'Vessel Trails' },
      { key: 'annotations', label: 'Annotations' },
      { key: 'heatmap', label: 'Vessel Heatmap' },
      { key: 'tssFlow', label: 'TSS Flow Arrows' },
      { key: 'tradeRoutes', label: 'Trade Routes' },
      { key: 'newsEvents', label: 'News Events' },
      { key: 'thermalActivity', label: 'Thermal Activity' },
    ] : []),
  ];

  return (
    <div className="w-full h-full relative">
      <MapContainer
        center={mapCenter}
        zoom={mapInitZoom}
        minZoom={5}
        maxZoom={18}
        maxBounds={mapMaxBounds}
        maxBoundsViscosity={1.0}
        zoomControl={false}
        className="w-full h-full"
        style={{ background: '#0a1628' }}
      >
        <TheaterFlyTo center={mapCenter} zoom={mapInitZoom} maxBounds={mapMaxBounds} />
        <TileLayerSwitcher tileKey={tileKey} />
        <ZoomControl position="topright" />
        <ZoomTracker onZoomChange={setZoom} />

        {/* Static overlays — conditionally rendered per layer settings (Singapore-specific for MERLION) */}
        {isMerlion && layers.rangeRings && <RangeRings />}
        {isMerlion && layers.borders && <MaritimeBordersLayer />}
        {isMerlion && layers.tssLanes && <TSSLanesLayer />}
        {isMerlion && layers.anchorageZones && <AnchorageZonesLayer />}
        {isMerlion && layers.labels && <RegionLabels />}
        {isMerlion && layers.militaryBases && <MilitaryBasesLayer zoom={zoom} />}

        {/* DJINN overlays (Strait of Hormuz) */}
        {isDjinn && layers.rangeRings && <DjinnRangeRings />}
        {isDjinn && layers.tssLanes && <DjinnTSSLanes />}
        {isDjinn && layers.borders && <DjinnBorders />}
        {isDjinn && layers.anchorageZones && <DjinnAnchorageZones />}
        {isDjinn && layers.labels && <DjinnLabels />}
        {isDjinn && layers.militaryBases && <DjinnNavalBases zoom={zoom} />}
        {isDjinn && <DjinnPorts />}
        {isDjinn && <DjinnOilTerminals />}
        {isDjinn && <DjinnStsHotspots />}
        {isDjinn && layers.heatmap && <DjinnHeatmap data={heatmapData} />}
        {isDjinn && layers.tssFlow && <DjinnTSSFlowArrows data={tssFlowData} />}
        {isDjinn && layers.tradeRoutes && <DjinnTradeRoutes />}
        {isDjinn && layers.settlements && <DjinnSettlements zoom={zoom} />}
        {isDjinn && layers.infrastructure && <DjinnInfrastructure zoom={zoom} />}
        {isDjinn && layers.vesselTrails && <DjinnVesselTrails vessels={vessels} />}
        {isDjinn && layers.annotations && <DjinnAnnotations vessels={vessels} alerts={alerts} zoom={zoom} />}
        {isDjinn && layers.newsEvents && <DjinnNewsEvents data={newsEvents} />}
        {isDjinn && layers.thermalActivity && <DjinnThermalDetections data={thermalData} />}

        {/* Vessel markers */}
        {layers.clustering ? (
          <MarkerClusterGroup
            chunkedLoading
            maxClusterRadius={40}
            disableClusteringAtZoom={14}
            iconCreateFunction={(cluster) => createClusterIcon(cluster, 'vessel')}
            spiderfyOnMaxZoom
          >
            {vesselMarkersJsx}
          </MarkerClusterGroup>
        ) : (
          vesselMarkersJsx
        )}

        {/* Aircraft markers */}
        {layers.clustering ? (
          <MarkerClusterGroup
            chunkedLoading
            maxClusterRadius={40}
            disableClusteringAtZoom={14}
            iconCreateFunction={(cluster) => createClusterIcon(cluster, 'flight')}
          >
            {flightMarkersJsx}
          </MarkerClusterGroup>
        ) : (
          flightMarkersJsx
        )}

        {/* Live flight trails */}
        {/* Weather stations overlay (NEA — MERLION only) */}
        {isMerlion && layers.weather && <WeatherOverlay neaWeather={neaWeather} zoom={zoom} />}

        {layers.flightTrails && Object.keys(flightTrails).length > 0 && (
          <FlightTrails flightTrails={flightTrails} />
        )}

        <FocusHandler focusedMmsi={focusedMmsi} vessels={vessels} />

        <TrackOverlay
          tracksData={tracksData}
          selectedEntities={selectedEntities}
          playbackIndices={playbackIndices}
        />
      </MapContainer>

      {/* Entity count overlay */}
      <div className="absolute top-3 left-3 text-[10px] text-gray-500 font-mono z-[1000]">
        {vessels.length > 0 || flights.length > 0
          ? `${vessels.length} vessels | ${flights.length} flights`
          : ''}
      </div>

      {/* M11: Layer control panel (bottom-left) */}
      <div className="absolute bottom-44 left-4 z-[1000] hidden lg:block">
        <button
          onClick={() => setLayerPanelOpen(!layerPanelOpen)}
          className={`text-[10px] font-semibold px-2 py-1 rounded border backdrop-blur-sm mb-1 ${
            layerPanelOpen
              ? 'bg-[#4A90E2]/20 border-[#4A90E2]/50 text-[#4A90E2]'
              : 'bg-[#1F1F1F]/70 border-gray-600 text-gray-500'
          }`}
        >
          LAYERS
        </button>

        {layerPanelOpen && (
          <div className="bg-[#1F1F1F]/95 border border-[#003A70]/40 rounded px-3 py-2 text-[10px] space-y-1 backdrop-blur-sm">
            {LAYER_OPTIONS.map((opt) => (
              <label key={opt.key} className="flex items-center gap-2 cursor-pointer text-gray-300 hover:text-white">
                <input
                  type="checkbox"
                  checked={layers[opt.key]}
                  onChange={() => toggleLayer(opt.key)}
                  className="rounded border-gray-500 text-[#4A90E2] focus:ring-[#4A90E2] w-3 h-3"
                />
                {opt.label}
              </label>
            ))}

            {/* M18: Tile switcher */}
            <div className="border-t border-gray-600 pt-1 mt-1">
              <div className="text-gray-500 text-[9px] uppercase tracking-wider mb-1">Map Style</div>
              <div className="flex gap-1">
                {Object.entries(TILE_LAYERS).map(([key, tile]) => (
                  <button
                    key={key}
                    onClick={() => setTileKey(key)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                      tileKey === key
                        ? 'bg-[#4A90E2] text-white'
                        : 'bg-[#003A70]/30 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {tile.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-[#1F1F1F]/90 border border-[#003A70]/40 rounded px-3 py-2 text-[10px] space-y-1.5 backdrop-blur-sm z-[1000]">
        {/* C6: Updated legend with vessel types */}
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-4 -7 8 14">
            <path d={VESSEL_PATHS.cargo} fill="#003A70" stroke="#4A90E2" strokeWidth="0.8" transform="scale(0.8)"/>
          </svg>
          <span className="text-gray-300">Cargo</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-5 -7 10 14">
            <path d={VESSEL_PATHS.tanker} fill="#8B4513" stroke="#CD853F" strokeWidth="0.8" transform="scale(0.8)"/>
          </svg>
          <span className="text-gray-300">Tanker</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-4 -7 8 14">
            <path d={VESSEL_PATHS.passenger} fill="#2563EB" stroke="#60A5FA" strokeWidth="0.8" transform="scale(0.8)"/>
          </svg>
          <span className="text-gray-300">Passenger</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-4 -7 8 14">
            <path d={VESSEL_PATHS.fishing} fill="#059669" stroke="#34D399" strokeWidth="0.8" transform="scale(0.7)"/>
          </svg>
          <span className="text-gray-300">Fishing</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-6 -8 12 16">
            <path d={VESSEL_PATHS.naval} fill="#7C3AED" stroke="#A78BFA" strokeWidth="0.8" transform="scale(0.7)"/>
          </svg>
          <span className="text-gray-300">Naval</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-4 -7 8 14">
            <path d={SHIP_PATH} fill="#C8102E" stroke="#ff6b6b" strokeWidth="1" transform="scale(0.8)"/>
          </svg>
          <span className="text-gray-300">Flagged</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-8 -9 16 20">
            <path d={PLANE_PATH} fill="#4A90E2" stroke="#7BB3F0" strokeWidth="0.8" transform="scale(0.7)"/>
          </svg>
          <span className="text-gray-300">Aircraft</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="5" fill="#1F1F1F90" stroke="#003A70" strokeWidth="1.2"/>
            <text x="7" y="8" fill="#4A90E2" fontSize="6" fontFamily="monospace" fontWeight="bold" textAnchor="middle" dominantBaseline="middle">5</text>
          </svg>
          <span className="text-gray-300">Cluster</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="12" height="12" viewBox="-6 -6 12 12">
            <path d="M0,-5 L5,0 L0,5 L-5,0 Z" fill="#7C3AED" fillOpacity="0.7" stroke="#7C3AED" strokeWidth="0.8"/>
          </svg>
          <span className="text-gray-300">Military Base</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-0 border-t border-dashed border-white/20 inline-block" />
          <span className="text-gray-300">Border</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-0 border-t border-dashed border-cyan-500 inline-block" />
          <span className="text-gray-300">TSS East</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-0 border-t border-dashed border-orange-500 inline-block" />
          <span className="text-gray-300">TSS West</span>
        </div>
      </div>
    </div>
  );
}
