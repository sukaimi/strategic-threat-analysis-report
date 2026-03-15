'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Map from '../components/MapWrapper';
import ThreatPanel from '../components/ThreatPanel';
import AlertsFeed from '../components/AlertsFeed';
import SystemStatus from '../components/SystemStatus';
import MissionBriefing from '../components/MissionBriefing';
import TrackPlayback from '../components/TrackPlayback';
import IntelFeed from '../components/IntelFeed';
import BottomNav from '../components/BottomNav';

function formatLocalTime(timeZone) {
  return new Date().toLocaleString('en-SG', {
    timeZone: timeZone || 'Asia/Singapore',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getThreatBg(score) {
  if (score >= 80) return 'bg-saf-red';
  if (score >= 60) return 'bg-saf-high';
  if (score >= 30) return 'bg-saf-medium';
  return 'bg-saf-army';
}

/** Format a Date into military DTG: DDHHMMZMmmYYYY */
function formatDTG(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'N/A';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const mon = months[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return `${dd}${hh}${mm}Z${mon}${yyyy}`;
}

const API_HEADERS = process.env.NEXT_PUBLIC_API_KEY
  ? { 'x-api-key': process.env.NEXT_PUBLIC_API_KEY }
  : {};

/** Theater configuration — mirrored from api/src/theaters.js for map rendering */
const THEATERS = {
  merlion: {
    name: 'MERLION',
    region: 'Singapore Strait',
    mapCenter: [1.25, 103.85],
    mapZoom: 11,
    mapBounds: [[-1.5, 99], [7.5, 108.5]],
    timeZone: 'Asia/Singapore',
    tzLabel: 'SGT',
  },
  djinn: {
    name: 'DJINN',
    region: 'Strait of Hormuz',
    mapCenter: [26.0, 55.5],
    mapZoom: 7,
    mapBounds: [[22, 48], [30, 62]],
    timeZone: 'Asia/Dubai',
    tzLabel: 'GST',
  },
};

function loadTheater() {
  if (typeof window === 'undefined') return 'merlion';
  try {
    const stored = localStorage.getItem('star_theater');
    if (stored && THEATERS[stored]) return stored;
  } catch (_) {}
  return 'merlion';
}

function apiFetch(url, opts = {}, theater) {
  const sep = url.includes('?') ? '&' : '?';
  const theaterParam = theater ? `${sep}theater=${theater}` : '';
  return fetch(`${url}${theaterParam}`, { ...opts, headers: { ...API_HEADERS, ...opts.headers } });
}

function playAlertTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch (_) {}
}

export default function Dashboard() {
  const [theater, setTheater] = useState(loadTheater);
  const theaterConfig = THEATERS[theater] || THEATERS.merlion;

  const switchTheater = useCallback((key) => {
    if (!THEATERS[key]) return;
    setTheater(key);
    try { localStorage.setItem('star_theater', key); } catch (_) {}
    // Reset data state on theater switch
    setVessels([]);
    setFlights([]);
    setWeather(null);
    setPortStatus(null);
    setAnalysis(null);
    setAlerts([]);
    setIntel([]);
    setSitrepData(null);
    setFlightTrails({});
    setNeaWeather(null);
    setHeatmapData([]);
    setTankerFlow(null);
    setTssFlowData(null);
    setNewsEvents([]);
    setThermalData([]);
    setLoading(true);
  }, []);

  const [vessels, setVessels] = useState([]);
  const [flights, setFlights] = useState([]);
  const [weather, setWeather] = useState(null);
  const [portStatus, setPortStatus] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [currentTime, setCurrentTime] = useState(formatLocalTime(theaterConfig.timeZone));
  const [focusedMmsi, setFocusedMmsi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [intel, setIntel] = useState([]);
  const [mobileTab, setMobileTab] = useState('map');
  const [flightTrails, setFlightTrails] = useState({});
  const [neaWeather, setNeaWeather] = useState(null);

  // Cross-theater state
  const [crossTheaterCount, setCrossTheaterCount] = useState(0);
  const [crossTheaterSanctioned, setCrossTheaterSanctioned] = useState(0);

  // Hormuz traffic counter (DJINN)
  const [hormuzTraffic, setHormuzTraffic] = useState(null);

  // DJINN: Vessel density heatmap, tanker flow, TSS flow
  const [heatmapData, setHeatmapData] = useState([]);
  const [tankerFlow, setTankerFlow] = useState(null);
  const [tssFlowData, setTssFlowData] = useState(null);

  // DJINN: GDELT news events and FIRMS thermal detections for map markers
  const [newsEvents, setNewsEvents] = useState([]);
  const [thermalData, setThermalData] = useState([]);

  // SITREP inline panel
  const [sitrepData, setSitrepData] = useState(null);
  const [sitrepLoading, setSitrepLoading] = useState(false);
  const [sitrepError, setSitrepError] = useState(null);

  // Sound toggle (persisted in localStorage)
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(true);
  useEffect(() => {
    const stored = localStorage.getItem('spectre_sound_enabled');
    if (stored !== null) {
      const val = stored !== 'false';
      setSoundEnabled(val);
      soundEnabledRef.current = val;
    }
  }, []);
  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      soundEnabledRef.current = next;
      localStorage.setItem('spectre_sound_enabled', String(next));
      return next;
    });
  }, []);

  // H11: Collapsible sidebar panels
  const [collapsedPanels, setCollapsedPanels] = useState(new Set(['sitrep']));

  const togglePanel = useCallback((panelName) => {
    setCollapsedPanels((prev) => {
      const next = new Set(prev);
      if (next.has(panelName)) {
        next.delete(panelName);
      } else {
        next.add(panelName);
      }
      return next;
    });
  }, []);

  // H12: aria-live region for alerts
  const ariaLiveRef = useRef(null);

  // --- Multi-track comparison state ---
  const [selectedEntities, setSelectedEntities] = useState([]);
  const [tracksData, setTracksData] = useState(new Map());
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [timeRange, setTimeRange] = useState({ from: '', to: '' });
  const playbackTimerRef = useRef(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(formatLocalTime(theaterConfig.timeZone)), 1000);
    return () => clearInterval(interval);
  }, [theaterConfig.timeZone]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [vesselsRes, flightsRes, weatherRes, portRes, analysisRes, alertsRes, intelRes] =
          await Promise.allSettled([
            apiFetch('/api/vessels', {}, theater).then((r) => r.ok ? r.json() : []),
            apiFetch('/api/flights', {}, theater).then((r) => r.ok ? r.json() : []),
            apiFetch('/api/weather', {}, theater).then((r) => r.ok ? r.json() : null),
            apiFetch('/api/port', {}, theater).then((r) => r.ok ? r.json() : null),
            apiFetch('/api/analyses', {}, theater).then((r) => r.ok ? r.json() : null),
            apiFetch('/api/alerts/all', {}, theater).then((r) => r.ok ? r.json() : []),
            apiFetch('/api/intel', {}, theater).then((r) => r.ok ? r.json() : []),
          ]);

        if (vesselsRes.status === 'fulfilled') setVessels(vesselsRes.value || []);
        if (flightsRes.status === 'fulfilled') setFlights(flightsRes.value || []);
        if (weatherRes.status === 'fulfilled') setWeather(weatherRes.value);
        if (portRes.status === 'fulfilled') setPortStatus(portRes.value);
        if (analysisRes.status === 'fulfilled') {
          const raw = analysisRes.value;
          if (raw?.threat_json) {
            try { setAnalysis(JSON.parse(raw.threat_json)); } catch (_) { setAnalysis(raw); }
          } else {
            setAnalysis(raw);
          }
        }
        if (alertsRes.status === 'fulfilled') setAlerts(alertsRes.value || []);
        if (intelRes?.status === 'fulfilled') setIntel(intelRes.value || []);
      } catch (err) {
        console.error('[SPECTRE] Initial data fetch failed:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [theater]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3002';
    const ws = new WebSocket(`${protocol}://${host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'vessels':
          case 'vessel_update':
            setVessels(msg.data);
            break;
          case 'flights':
          case 'flight_update':
            setFlights(msg.data);
            break;
          case 'weather':
          case 'weather_update':
            setWeather(msg.data);
            break;
          case 'analysis':
          case 'analysis_update':
            setAnalysis(msg.data);
            break;
          case 'alert':
          case 'new_alert':
            setAlerts((prev) => [msg.data, ...prev].slice(0, 100));
            if (['CRITICAL', 'HIGH'].includes((msg.data?.severity || '').toUpperCase())) {
              if (soundEnabledRef.current) playAlertTone();
              // H12: Announce to aria-live region
              if (ariaLiveRef.current) {
                const severity = (msg.data.severity || '').toUpperCase();
                const title = msg.data.title || msg.data.message || 'New alert';
                ariaLiveRef.current.textContent = `${severity} alert: ${title}`;
              }
            }
            break;
          case 'alerts':
            setAlerts(msg.data);
            break;
          case 'intel':
            setIntel(msg.data);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('[SPECTRE] WS parse error:', err);
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
    };

    ws.onerror = (err) => {
      console.error('[SPECTRE] WS error:', err);
      ws.close();
    };
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket]);

  const handleAcknowledge = async (alertId) => {
    try {
      await apiFetch(`/api/alerts/${alertId}/acknowledge`, { method: 'PATCH' }, theater);
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, acknowledged: 1, status: 'ACKNOWLEDGED' } : a))
      );
    } catch (err) {
      console.error('[SPECTRE] Failed to acknowledge alert:', err);
    }
  };

  // Fetch flight trails every 30s
  useEffect(() => {
    async function fetchTrails() {
      try {
        const res = await apiFetch('/api/flights/trails', {}, theater);
        if (res.ok) setFlightTrails(await res.json());
      } catch (_) {}
    }
    fetchTrails();
    const interval = setInterval(fetchTrails, 30_000);
    return () => clearInterval(interval);
  }, [theater]);

  // Fetch cross-theater vessel count every 2 min
  useEffect(() => {
    async function fetchCrossTheater() {
      try {
        const res = await apiFetch('/api/cross-theater/vessels', {});
        if (res.ok) {
          const data = await res.json();
          setCrossTheaterCount(data.count || 0);
          // Count sanctioned vessels from the briefing
          try {
            const briefRes = await apiFetch('/api/cross-theater/briefing', {});
            if (briefRes.ok) {
              const briefing = await briefRes.json();
              setCrossTheaterSanctioned((briefing.crossTheater?.sharedSanctions || []).length);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
    fetchCrossTheater();
    const interval = setInterval(fetchCrossTheater, 120_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch Hormuz traffic counter every 2 min (DJINN only)
  useEffect(() => {
    if (theater !== 'djinn') { setHormuzTraffic(null); return; }
    async function fetchHormuz() {
      try {
        const res = await apiFetch('/api/health', {}, theater);
        if (res.ok) {
          const data = await res.json();
          setHormuzTraffic(data.hormuzTraffic ?? null);
        }
      } catch (_) {}
    }
    fetchHormuz();
    const interval = setInterval(fetchHormuz, 120_000);
    return () => clearInterval(interval);
  }, [theater]);

  // Fetch NEA weather station data every 5 min (MERLION only — NEA is Singapore-specific)
  useEffect(() => {
    if (theater !== 'merlion') { setNeaWeather(null); return; }
    async function fetchNea() {
      try {
        const res = await apiFetch('/api/nea/weather', {}, theater);
        if (res.ok) setNeaWeather(await res.json());
      } catch (_) {}
    }
    fetchNea();
    const interval = setInterval(fetchNea, 300_000);
    return () => clearInterval(interval);
  }, [theater]);

  // Fetch DJINN-specific analytics: heatmap, tanker flow, TSS flow (every 60s)
  useEffect(() => {
    if (theater !== 'djinn') {
      setHeatmapData([]);
      setTankerFlow(null);
      setTssFlowData(null);
      return;
    }
    async function fetchDjinnAnalytics() {
      try {
        const [heatRes, flowRes, tssRes] = await Promise.allSettled([
          apiFetch('/api/vessels/density', {}, theater).then((r) => r.ok ? r.json() : []),
          apiFetch('/api/vessels/tanker-flow', {}, theater).then((r) => r.ok ? r.json() : null),
          apiFetch('/api/vessels/tss-flow', {}, theater).then((r) => r.ok ? r.json() : null),
        ]);
        if (heatRes.status === 'fulfilled') setHeatmapData(heatRes.value || []);
        if (flowRes.status === 'fulfilled') setTankerFlow(flowRes.value || null);
        if (tssRes.status === 'fulfilled') setTssFlowData(tssRes.value || null);
      } catch (_) {}
    }
    fetchDjinnAnalytics();
    const interval = setInterval(fetchDjinnAnalytics, 60_000);
    return () => clearInterval(interval);
  }, [theater]);

  // Fetch DJINN-specific GDELT news events and FIRMS thermal detections (every 5 min)
  useEffect(() => {
    if (theater !== 'djinn') {
      setNewsEvents([]);
      setThermalData([]);
      return;
    }
    async function fetchDjinnLayers() {
      try {
        const [newsRes, thermalRes] = await Promise.allSettled([
          apiFetch('/api/intel?minScore=30&hours=48&limit=100', {}, theater).then((r) => r.ok ? r.json() : []),
          apiFetch('/api/thermal?hours=24&limit=500', {}, theater).then((r) => r.ok ? r.json() : []),
        ]);
        if (newsRes.status === 'fulfilled') setNewsEvents(newsRes.value || []);
        if (thermalRes.status === 'fulfilled') setThermalData(thermalRes.value || []);
      } catch (_) {}
    }
    fetchDjinnLayers();
    const interval = setInterval(fetchDjinnLayers, 300_000);
    return () => clearInterval(interval);
  }, [theater]);

  const handleFocusVessel = (mmsi) => {
    setFocusedMmsi(mmsi);
    setMobileTab('map');
    setTimeout(() => setFocusedMmsi(null), 5000);
  };

  const handleMobileTabChange = (tab) => {
    setMobileTab(tab);
    if (tab === 'map') setSidebarOpen(false);
    else setSidebarOpen(true);
  };

  const fetchSitrep = useCallback(async () => {
    setSitrepLoading(true);
    try {
      const res = await apiFetch('/api/reports/sitrep?format=json', {}, theater);
      if (!res.ok) throw new Error('SITREP fetch failed');
      const data = await res.json();
      setSitrepData(data);
      setSitrepError(null);
    } catch (err) {
      console.error('[SPECTRE] SITREP fetch failed:', err);
      setSitrepError(err.message);
    } finally {
      setSitrepLoading(false);
    }
  }, [theater]);

  // Auto-fetch SITREP on mount and refresh every 5 minutes
  useEffect(() => {
    fetchSitrep();
    const interval = setInterval(fetchSitrep, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchSitrep]);

  // --- Multi-track: fetch track data for an entity ---
  const fetchTrackData = useCallback(async (entity) => {
    const isVessel = entity.type === 'vessel';
    const id = isVessel ? entity.mmsi : (entity.callsign || entity.flight_number);
    const base = isVessel ? `/api/vessels/${encodeURIComponent(id)}/track` : `/api/flights/${encodeURIComponent(id)}/track`;

    const params = new URLSearchParams();
    if (timeRange.from) params.set('from', new Date(timeRange.from).toISOString());
    if (timeRange.to) params.set('to', new Date(timeRange.to).toISOString());
    const qs = params.toString();
    const url = qs ? `${base}?${qs}` : base;

    try {
      const res = await apiFetch(url, {}, theater);
      if (!res.ok) return [];
      return await res.json();
    } catch (err) {
      console.error('[SPECTRE] Track fetch failed:', err);
      return [];
    }
  }, [timeRange, theater]);

  // --- Multi-track: handle entity selection (toggle) ---
  const handleSelectEntity = useCallback(async (entity) => {
    const isVessel = entity.type === 'vessel';
    const id = isVessel ? String(entity.mmsi) : String(entity.callsign || entity.flight_number);

    setSelectedEntities((prev) => {
      const exists = prev.some((e) => {
        const eid = e.type === 'vessel' ? String(e.mmsi) : String(e.callsign || e.flight_number);
        return eid === id;
      });

      if (exists) {
        setTracksData((td) => {
          const next = new Map(td);
          next.delete(id);
          return next;
        });
        return prev.filter((e) => {
          const eid = e.type === 'vessel' ? String(e.mmsi) : String(e.callsign || e.flight_number);
          return eid !== id;
        });
      }

      if (prev.length >= 5) return prev;

      fetchTrackData(entity).then((positions) => {
        setTracksData((td) => {
          const next = new Map(td);
          next.set(id, positions);
          return next;
        });
      });

      return [...prev, entity];
    });

    setPlaybackIndex(0);
    setIsPlaying(false);
  }, [fetchTrackData]);

  const handleRemoveEntity = useCallback((id) => {
    setSelectedEntities((prev) => prev.filter((e) => {
      const eid = e.type === 'vessel' ? String(e.mmsi) : String(e.callsign || e.flight_number);
      return eid !== String(id);
    }));
    setTracksData((td) => {
      const next = new Map(td);
      next.delete(String(id));
      return next;
    });
    setPlaybackIndex(0);
    setIsPlaying(false);
  }, []);

  const handleClearAllTracks = useCallback(() => {
    setSelectedEntities([]);
    setTracksData(new Map());
    setPlaybackIndex(0);
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    if (selectedEntities.length === 0) return;
    const refetchAll = async () => {
      const entries = await Promise.all(
        selectedEntities.map(async (entity) => {
          const id = entity.type === 'vessel' ? entity.mmsi : (entity.callsign || entity.flight_number);
          const positions = await fetchTrackData(entity);
          return [String(id), positions];
        })
      );
      setTracksData(new Map(entries));
      setPlaybackIndex(0);
    };
    refetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange, fetchTrackData]);

  const totalFrames = useMemo(() => {
    if (!(tracksData instanceof Map)) return 0;
    let max = 0;
    for (const positions of tracksData.values()) {
      if (positions.length > max) max = positions.length;
    }
    return max;
  }, [tracksData]);

  const playbackIndices = useMemo(() => {
    if (!(tracksData instanceof Map)) return {};
    const indices = {};
    if (totalFrames <= 1) {
      for (const [id, positions] of tracksData.entries()) {
        indices[id] = positions.length - 1;
      }
      return indices;
    }
    const ratio = playbackIndex / (totalFrames - 1);
    for (const [id, positions] of tracksData.entries()) {
      indices[id] = Math.min(Math.round(ratio * (positions.length - 1)), positions.length - 1);
    }
    return indices;
  }, [tracksData, playbackIndex, totalFrames]);

  useEffect(() => {
    if (!isPlaying || totalFrames < 2) return;
    playbackTimerRef.current = setInterval(() => {
      setPlaybackIndex((prev) => {
        if (prev >= totalFrames - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 200 / playbackSpeed);
    return () => clearInterval(playbackTimerRef.current);
  }, [isPlaying, playbackSpeed, totalFrames]);

  const compositeScore = analysis?.composite_score ?? analysis?.compositeScore ?? 0;

  // Parse SITREP analysis (may have threat_json as a nested JSON string)
  const sitrepAnalysis = useMemo(() => {
    if (!sitrepData?.analysis) return null;
    const raw = sitrepData.analysis;
    if (raw.threat_json && typeof raw.threat_json === 'string') {
      try { return { ...raw, ...JSON.parse(raw.threat_json) }; } catch (_) { return raw; }
    }
    return raw;
  }, [sitrepData]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-saf-light">
      {/* H12: Visually-hidden aria-live region for screen reader announcements */}
      <div
        ref={ariaLiveRef}
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', borderWidth: 0 }}
      />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-50 bg-saf-dark flex items-center justify-center">
          <div className="text-center">
            <div className="w-10 h-10 border-3 border-saf-navy border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <div className="text-white font-semibold text-lg tracking-widest">STAR</div>
            <div className="text-gray-400 text-sm mt-1">{theaterConfig.name} -- Initialising feeds...</div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-5 py-2.5 bg-saf-navy shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-1 h-6 bg-saf-red rounded-full" />
          <div>
            <h1 className="text-base font-bold tracking-widest text-white leading-none">
              STAR <span className="text-[10px] font-medium tracking-wider text-blue-300">codename {theaterConfig.name}</span>
            </h1>
            <span className="text-[10px] uppercase tracking-wider text-saf-airforce hidden sm:inline">
              {theaterConfig.region}
            </span>
          </div>
          {/* Theater selector */}
          <div className="flex items-center gap-1 ml-2">
            {Object.entries(THEATERS).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => switchTheater(key)}
                className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-colors ${
                  theater === key
                    ? 'bg-blue-500 text-white'
                    : 'bg-blue-900/40 text-blue-300 hover:bg-blue-800/60 hover:text-white border border-blue-500/20'
                }`}
                title={cfg.region}
              >
                {cfg.name}
              </button>
            ))}
            {/* Cross-theater indicator badges */}
            {crossTheaterCount > 0 && (
              <span
                className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-cyan-700/60 text-cyan-200 border border-cyan-500/30"
                title={`${crossTheaterCount} vessel(s) detected in multiple theaters`}
              >
                {crossTheaterCount} XTH
              </span>
            )}
            {crossTheaterSanctioned > 0 && (
              <span
                className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-red-700/80 text-red-200 border border-red-500/40 animate-pulse"
                title={`${crossTheaterSanctioned} sanctioned vessel(s) transiting between theaters`}
              >
                {crossTheaterSanctioned} SAN
              </span>
            )}
            {theater === 'djinn' && hormuzTraffic != null && hormuzTraffic > 0 && (
              <span
                className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-amber-700/60 text-amber-200 border border-amber-500/30"
                title={`${hormuzTraffic} vessel(s) in Hormuz TSS in the last hour`}
              >
                {hormuzTraffic} TSS
              </span>
            )}
            {theater === 'djinn' && tankerFlow && (tankerFlow.inbound > 0 || tankerFlow.outbound > 0) && (
              <span
                className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-amber-800/60 text-amber-200 border border-amber-500/30"
                title={`Oil tanker flow through Hormuz: ${tankerFlow.inbound} inbound, ${tankerFlow.outbound} outbound`}
              >
                {'\u25B2'}{tankerFlow.inbound} IN / {'\u25BC'}{tankerFlow.outbound} OUT
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-5">
          {/* Threat Score Badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-blue-200 hidden sm:inline">
              Threat
            </span>
            <span
              className={`px-2.5 py-0.5 rounded text-sm font-semibold ${getThreatBg(compositeScore)} text-white`}
            >
              {Math.round(compositeScore)}
            </span>
          </div>

          {/* M15: Vessel/flight counts */}
          <div className="text-[10px] text-blue-200 font-mono hidden sm:flex items-center gap-2">
            <span>{vessels.length} V</span>
            <span className="text-blue-400">|</span>
            <span>{flights.length} F</span>
          </div>

          {/* M15: Weather summary */}
          {weather?.wind_speed_kt != null && (
            <div className="text-[10px] text-blue-200 font-mono hidden md:flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path d="M9.59 4.59A2 2 0 1111 8H2m10.59 11.41A2 2 0 1014 16H2m15.73-8.27A2.5 2.5 0 1119.5 12H2" />
              </svg>
              <span>{Math.round(weather.wind_speed_kt)}kn</span>
            </div>
          )}

          {/* Sound Toggle */}
          <button
            onClick={toggleSound}
            className="text-blue-200 hover:text-white border border-blue-400/30 rounded px-2 py-0.5 text-[10px] font-semibold hidden sm:inline-flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-saf-airforce"
            title={soundEnabled ? 'Mute alert sounds' : 'Unmute alert sounds'}
          >
            {soundEnabled ? 'SND ON' : 'SND OFF'}
          </button>

          {/* Connection Status */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-green-400' : 'bg-saf-red'
              }`}
            />
            <span className="text-xs text-blue-200 hidden sm:inline">
              {wsConnected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>

          {/* Clock */}
          <div className="text-sm text-white font-medium hidden sm:block">
            {currentTime} <span className="text-blue-300 text-xs">{theaterConfig.tzLabel}</span>
          </div>

          {/* Sidebar toggle (tablet) */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="hidden md:inline-flex lg:hidden text-blue-200 hover:text-white border border-blue-400/30 rounded px-2.5 py-1 text-xs font-semibold focus-visible:ring-2 focus-visible:ring-saf-airforce"
          >
            {sidebarOpen ? 'MAP' : 'INTEL'}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Map Area */}
        <div className={`relative bg-saf-dark h-full transition-all duration-300 w-full ${sidebarOpen ? 'md:hidden lg:block' : ''} lg:w-[70%]`}>
          <Map
            vessels={vessels}
            flights={flights}
            focusedMmsi={focusedMmsi}
            selectedEntities={selectedEntities}
            tracksData={tracksData}
            playbackIndices={playbackIndices}
            onSelectEntity={handleSelectEntity}
            flightTrails={flightTrails}
            neaWeather={neaWeather}
            theaterKey={theater}
            center={theaterConfig.mapCenter}
            zoom={theaterConfig.mapZoom}
            maxBounds={theaterConfig.mapBounds}
            heatmapData={heatmapData}
            tssFlowData={tssFlowData}
            alerts={alerts}
            newsEvents={newsEvents}
            thermalData={thermalData}
          />
          <TrackPlayback
            selectedEntities={selectedEntities}
            tracksData={tracksData}
            playbackIndex={playbackIndex}
            totalFrames={totalFrames}
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
            timeRange={timeRange}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onSeek={setPlaybackIndex}
            onSpeedChange={setPlaybackSpeed}
            onRemoveEntity={handleRemoveEntity}
            onClearAll={handleClearAllTracks}
            onTimeRangeChange={setTimeRange}
          />
        </div>

        {/* Desktop sidebar */}
        <aside className={`border-l border-gray-200 flex-col overflow-hidden bg-saf-light hidden ${sidebarOpen ? 'md:flex' : ''} lg:flex lg:w-[30%]`}>
          <div className="flex-1 overflow-y-auto pb-8">
            {/* SITREP Panel — permanent, default collapsed */}
            <div className="border-b border-gray-700">
              <button
                onClick={() => togglePanel('sitrep')}
                className="w-full flex items-center justify-between px-4 py-2.5 bg-saf-dark hover:bg-gray-800 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <div className="w-1 h-4 bg-amber-400 rounded-full" />
                  <span className="text-xs uppercase tracking-widest text-amber-400 font-bold">SITREP</span>
                  {sitrepData && sitrepAnalysis && (
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                      getThreatBg(sitrepAnalysis.composite_score ?? sitrepAnalysis.compositeScore ?? 0)
                    } text-white`}>
                      {Math.round(sitrepAnalysis.composite_score ?? sitrepAnalysis.compositeScore ?? 0)}
                    </span>
                  )}
                </div>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`w-4 h-4 text-gray-400 transition-transform ${collapsedPanels.has('sitrep') ? '-rotate-90' : ''}`}
                >
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>

              {!collapsedPanels.has('sitrep') && (
                <div className="px-4 py-3 bg-gray-900/80">
                  {sitrepLoading && !sitrepData && (
                    <div className="flex items-center justify-center py-6">
                      <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mr-2" />
                      <span className="text-xs text-blue-300 uppercase tracking-wider">Loading SITREP...</span>
                    </div>
                  )}

                  {!sitrepLoading && !sitrepData && (
                    <div className="text-red-400 text-center text-xs py-4">
                      Failed to load SITREP.{' '}
                      <button onClick={fetchSitrep} className="underline hover:text-red-300">Retry</button>
                    </div>
                  )}

                  {sitrepData && (
                    <>
                    {sitrepError && (
                      <div className="flex items-center justify-between bg-red-900/40 border border-red-500/30 rounded px-3 py-1.5 mb-2 text-[10px] text-red-300">
                        <span>Refresh failed — showing stale data</span>
                        <button onClick={fetchSitrep} disabled={sitrepLoading} className="underline hover:text-red-200 ml-2 disabled:opacity-50">Retry</button>
                      </div>
                    )}
                    <div className="space-y-3 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-blue-400 font-mono tracking-wider">
                          DTG: {formatDTG(sitrepData.analysis?.recorded_at || new Date())}
                        </span>
                        <button
                          onClick={fetchSitrep}
                          disabled={sitrepLoading}
                          className="text-[9px] text-blue-300 hover:text-white border border-blue-500/30 hover:border-blue-400/60 rounded px-1.5 py-0.5 uppercase tracking-wider font-semibold transition-colors disabled:opacity-50"
                        >
                          {sitrepLoading ? 'LOADING...' : 'REFRESH'}
                        </button>
                      </div>

                      {sitrepAnalysis && (
                        <div className="border-t border-blue-400/10 pt-2">
                          <div className="text-[9px] uppercase tracking-wider text-gray-400 mb-1">Threat Assessment</div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              getThreatBg(sitrepAnalysis.composite_score ?? sitrepAnalysis.compositeScore ?? 0)
                            } text-white`}>
                              {(sitrepAnalysis.threat_level ?? sitrepAnalysis.threatLevel ?? 'UNKNOWN').toUpperCase()}
                            </span>
                            <span className="text-gray-400 font-mono">
                              Score: <span className="text-white font-semibold">{Math.round(sitrepAnalysis.composite_score ?? sitrepAnalysis.compositeScore ?? 0)}</span>/100
                            </span>
                          </div>

                          {(sitrepAnalysis.tactical_brief ?? sitrepAnalysis.tacticalBrief ?? sitrepAnalysis.summary) && (
                            <div className="mt-2">
                              <div className="text-[9px] uppercase tracking-wider text-gray-400 mb-1">Tactical Brief</div>
                              <p className="text-gray-300 leading-relaxed text-[11px]">
                                {sitrepAnalysis.tactical_brief ?? sitrepAnalysis.tacticalBrief ?? sitrepAnalysis.summary}
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="border-t border-blue-400/10 pt-2">
                        <div className="text-[9px] uppercase tracking-wider text-gray-400 mb-1">
                          Active Alerts{' '}
                          <span className="text-amber-400 font-bold">({sitrepData.alerts?.length || 0})</span>
                        </div>
                        {sitrepData.alerts && sitrepData.alerts.length > 0 ? (
                          <div className="space-y-1 max-h-32 overflow-y-auto">
                            {sitrepData.alerts.slice(0, 10).map((a, i) => (
                              <div key={a.id || i} className="flex items-start gap-1.5 text-[11px]">
                                <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                                  (a.severity || '').toUpperCase() === 'CRITICAL' ? 'bg-red-500' :
                                  (a.severity || '').toUpperCase() === 'HIGH' ? 'bg-orange-500' :
                                  (a.severity || '').toUpperCase() === 'MEDIUM' ? 'bg-yellow-500' :
                                  'bg-blue-500'
                                }`} />
                                <span className="text-gray-300 leading-tight">
                                  <span className="font-semibold font-mono">{(a.severity || 'INFO').toUpperCase().slice(0, 4)}</span>{' '}
                                  {a.title || a.message || 'Alert'}
                                </span>
                              </div>
                            ))}
                            {sitrepData.alerts.length > 10 && (
                              <div className="text-gray-500 text-[9px]">+{sitrepData.alerts.length - 10} more</div>
                            )}
                          </div>
                        ) : (
                          <p className="text-[11px] text-gray-500 italic">No active alerts</p>
                        )}
                      </div>

                      <div className="border-t border-blue-400/10 pt-2">
                        <div className="text-[9px] uppercase tracking-wider text-gray-400 mb-1">Force Disposition</div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="bg-saf-navy/50 rounded p-1.5 text-center">
                            <div className="text-lg font-bold text-blue-300 font-mono">{sitrepData.vesselCount ?? 0}</div>
                            <div className="text-[9px] text-gray-400 uppercase">Vessels</div>
                          </div>
                          <div className="bg-saf-navy/50 rounded p-1.5 text-center">
                            <div className="text-lg font-bold text-blue-300 font-mono">{sitrepData.flightCount ?? 0}</div>
                            <div className="text-[9px] text-gray-400 uppercase">Flights</div>
                          </div>
                          {theater === 'djinn' && (
                            <>
                              <div className="bg-saf-navy/50 rounded p-1.5 text-center">
                                <div className="text-lg font-bold text-amber-300 font-mono">{sitrepData.tankerCount ?? 0}</div>
                                <div className="text-[9px] text-gray-400 uppercase">Tankers</div>
                              </div>
                              <div className="bg-saf-navy/50 rounded p-1.5 text-center">
                                <div className="text-lg font-bold text-red-400 font-mono">{sitrepData.flaggedCount ?? 0}</div>
                                <div className="text-[9px] text-gray-400 uppercase">Flagged</div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      {sitrepData.weather && (
                        <div className="border-t border-blue-400/10 pt-2">
                          <div className="text-[9px] uppercase tracking-wider text-gray-400 mb-1">Weather</div>
                          <div className="text-gray-300 text-[10px] font-mono space-y-0.5">
                            {sitrepData.weather.wind_speed_kt != null && (
                              <div>Wind: {Math.round(sitrepData.weather.wind_speed_kt)} kn{sitrepData.weather.wind_dir != null ? ` @ ${Math.round(sitrepData.weather.wind_dir)}\u00B0` : ''}</div>
                            )}
                            {sitrepData.weather.visibility_km != null && <div>Vis: {sitrepData.weather.visibility_km} km</div>}
                            {sitrepData.weather.sea_state != null && <div>Sea State: {sitrepData.weather.sea_state}</div>}
                          </div>
                        </div>
                      )}
                    </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Analysis interval notice */}
            <div className="px-4 py-2 bg-gray-800/50 border-y border-gray-700/50">
              <div className="flex items-start gap-2 text-[10px] text-gray-500">
                <span className="text-blue-400/60 mt-0.5">ℹ</span>
                <span>AI threat analysis cycles every 2h to optimise costs. Rule-based anomaly detection runs every 60s in real-time.</span>
              </div>
            </div>

            <ThreatPanel
              analysis={analysis}
              onFocusVessel={handleFocusVessel}
              collapsed={collapsedPanels.has('threat')}
              onToggle={() => togglePanel('threat')}
              theaterKey={theater}
            />
            <AlertsFeed
              alerts={alerts}
              onAcknowledge={handleAcknowledge}
              onFocusVessel={handleFocusVessel}
              collapsed={collapsedPanels.has('alerts')}
              onToggle={() => togglePanel('alerts')}
            />
            <IntelFeed
              articles={intel}
              collapsed={collapsedPanels.has('intel')}
              onToggle={() => togglePanel('intel')}
            />
            <SystemStatus
              wsConnected={wsConnected}
              vessels={vessels}
              flights={flights}
              weather={weather}
              portStatus={portStatus}
              analysis={analysis}
              collapsed={collapsedPanels.has('status')}
              onToggle={() => togglePanel('status')}
            />

            <MissionBriefing
              collapsed={collapsedPanels.has('mission')}
              onToggle={() => togglePanel('mission')}
            />
          </div>
        </aside>

        {/* Mobile bottom sheet panel */}
        {mobileTab !== 'map' && (
          <div className="lg:hidden absolute inset-x-0 bottom-0 z-[1500] bottom-sheet-enter">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setMobileTab('map')} />
            <div className="relative bg-saf-light rounded-t-2xl max-h-[65vh] flex flex-col shadow-2xl bottom-sheet-panel">
              <div className="flex justify-center py-2 shrink-0">
                <div className="w-10 h-1 bg-gray-300 rounded-full" />
              </div>
              <div className="flex items-center justify-between px-4 pb-2 shrink-0">
                <h2 className="text-xs uppercase tracking-widest text-saf-navy font-bold">
                  {mobileTab === 'threats' && 'Threat Assessment'}
                  {mobileTab === 'alerts' && 'Alerts Feed'}
                  {mobileTab === 'intel' && 'Intel Feed'}
                  {mobileTab === 'status' && 'System Status'}
                </h2>
                <button onClick={() => setMobileTab('map')} className="text-saf-mid hover:text-saf-dark text-xs font-semibold px-2 py-1 min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-saf-airforce">
                  CLOSE
                </button>
              </div>
              <div className="flex-1 overflow-y-auto overscroll-contain touch-scroll-y pb-16">
                {mobileTab === 'threats' && (
                  <ThreatPanel analysis={analysis} onFocusVessel={handleFocusVessel} theaterKey={theater} />
                )}
                {mobileTab === 'alerts' && (
                  <AlertsFeed alerts={alerts} onAcknowledge={handleAcknowledge} onFocusVessel={handleFocusVessel} />
                )}
                {mobileTab === 'intel' && <IntelFeed articles={intel} />}
                {mobileTab === 'status' && (
                  <><SystemStatus wsConnected={wsConnected} vessels={vessels} flights={flights} weather={weather} portStatus={portStatus} analysis={analysis} /><MissionBriefing /></>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      <BottomNav
        activeTab={mobileTab}
        onTabChange={handleMobileTabChange}
        alertCount={alerts.filter((a) => !a.acknowledged).length}
      />
    </div>
  );
}
