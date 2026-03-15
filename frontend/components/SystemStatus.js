'use client';

import { useState, useEffect } from 'react';

const API_HEADERS = typeof window !== 'undefined' && process.env.NEXT_PUBLIC_API_KEY
  ? { 'x-api-key': process.env.NEXT_PUBLIC_API_KEY }
  : {};

// Expected poll intervals per collector (ms) — mirrors api/src/collectors/index.js
const EXPECTED_INTERVALS = {
  mpa:     3 * 60 * 1000,
  ais:     30_000,
  flights: 15_000,
  weather: 900_000,
  port:    300_000,
};

/**
 * Determine freshness indicator from a lastUpdate timestamp.
 * A collector is "stale" if older than 2x its expected interval.
 */
function collectorIndicator(lastUpdate, collectorName) {
  if (!lastUpdate) return { color: 'bg-saf-red', label: 'No Data' };

  const ageMs = Date.now() - new Date(lastUpdate).getTime();
  const threshold = (EXPECTED_INTERVALS[collectorName] || 60_000) * 2;

  if (ageMs < threshold) {
    const ageMin = Math.round(ageMs / 60000);
    return { color: 'bg-saf-army', label: ageMin < 1 ? '<1m ago' : `${ageMin}m ago` };
  }

  const ageMin = Math.round(ageMs / 60000);
  return { color: 'bg-saf-red', label: `${ageMin}m ago (stale)` };
}

function freshnessIndicator(lastUpdated, thresholdMinutes = 5) {
  if (!lastUpdated) return { color: 'bg-gray-400', label: 'No Data' };
  const ageMs = Date.now() - new Date(lastUpdated).getTime();
  const ageMin = ageMs / 60000;
  if (ageMin < thresholdMinutes) return { color: 'bg-saf-army', label: `${Math.round(ageMin)}m ago` };
  if (ageMin < thresholdMinutes * 3) return { color: 'bg-saf-medium', label: `${Math.round(ageMin)}m ago` };
  return { color: 'bg-saf-red', label: `${Math.round(ageMin)}m ago` };
}

function StatusRow({ label, indicator, value }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${indicator}`} />
        <span className="text-[12px] text-saf-dark">{label}</span>
      </div>
      <span className="text-[12px] text-saf-mid font-semibold">{value}</span>
    </div>
  );
}

function windDirLabel(deg) {
  if (deg == null) return 'N/A';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function seaStateColor(state) {
  if (!state) return 'text-saf-mid';
  const s = state.toLowerCase();
  if (s === 'calm' || s === 'smooth') return 'text-saf-army';
  if (s === 'slight' || s === 'moderate') return 'text-saf-medium';
  return 'text-saf-red';
}

// Friendly display names for collectors
const COLLECTOR_LABELS = {
  ais:     'AIS Stream',
  mpa:     'MPA OCEANS-X',
  flights: 'Flight Tracks',
  weather: 'Weather',
  port:    'Port Status',
};

export default function SystemStatus({
  wsConnected = false,
  vessels = [],
  flights = [],
  weather = null,
  portStatus = null,
  analysis = null,
  collapsed = false,
  onToggle,
}) {
  const [health, setHealth] = useState(null);

  // Poll the health endpoint every 30 seconds
  useEffect(() => {
    let cancelled = false;

    async function fetchHealth() {
      try {
        const res = await fetch('/api/health', { headers: API_HEADERS });
        if (res.ok && !cancelled) {
          setHealth(await res.json());
        }
      } catch (_) {
        // Silently ignore — will retry next interval
      }
    }

    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const analysisTimestamp = analysis
    ? (analysis.recorded_at || analysis.created_at || analysis.createdAt || analysis.timestamp || null)
    : null;
  const analysisFreshness = freshnessIndicator(analysisTimestamp, 10);

  const collectors = health?.collectors || {};
  const dbCounts = health?.db || {};
  const aiInfo = health?.ai || {};

  return (
    <div className="saf-card m-3 space-y-4">
      <button
        className="flex items-center justify-between w-full focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold">
          System Status
        </h2>
        <span className={`text-xs text-saf-mid transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}>
          &#9650;
        </span>
      </button>

      <div
        className={`transition-all duration-300 overflow-hidden ${collapsed ? 'max-h-0' : 'max-h-[2000px]'}`}
      >
        {/* Weather Panel */}
        {weather && (weather.wind_speed_kt != null || weather.sea_state) && (
          <div>
            <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold mb-2">
              Weather &amp; Sea State
            </h2>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <div className="text-[10px] uppercase text-saf-mid font-medium">Wind</div>
                <div className="text-sm font-semibold text-saf-dark">
                  {weather.wind_speed_kt != null ? `${Math.round(weather.wind_speed_kt)} kn` : 'N/A'}
                  {weather.wind_dir != null && (
                    <span className="text-saf-mid ml-1 font-normal">{windDirLabel(weather.wind_dir)}</span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-saf-mid font-medium">Visibility</div>
                <div className="text-sm font-semibold text-saf-dark">
                  {weather.visibility_km != null ? `${weather.visibility_km} km` : 'N/A'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-saf-mid font-medium">Sea State</div>
                <div className={`text-sm font-semibold capitalize ${seaStateColor(weather.sea_state)}`}>
                  {weather.sea_state || 'N/A'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-saf-mid font-medium">CB Cells</div>
                <div className={`text-sm font-semibold ${weather.cb_cells > 0 ? 'text-saf-red' : 'text-saf-dark'}`}>
                  {weather.cb_cells > 0 ? 'DETECTED' : 'Clear'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Port Status */}
        {portStatus && (portStatus.vessels_queued != null || portStatus.berth_utilisation != null) && (
          <div className="pt-3 border-t border-gray-200">
            <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold mb-2">
              Port Status
            </h2>
            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-saf-dark font-medium">Berth Utilisation</span>
                  <span className="text-saf-mid font-semibold">
                    {portStatus.berth_utilisation != null ? `${Math.round(portStatus.berth_utilisation * 100)}%` : 'N/A'}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      portStatus.berth_utilisation >= 0.8 ? 'bg-saf-red' :
                      portStatus.berth_utilisation >= 0.5 ? 'bg-saf-medium' : 'bg-saf-army'
                    }`}
                    style={{ width: `${Math.min((portStatus.berth_utilisation || 0) * 100, 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-saf-dark font-medium">Channel Flow</span>
                  <span className="text-saf-mid font-semibold">
                    {portStatus.channel_flow_pct != null ? `${Math.round(portStatus.channel_flow_pct)}%` : 'N/A'}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      portStatus.channel_flow_pct >= 80 ? 'bg-saf-red' :
                      portStatus.channel_flow_pct >= 50 ? 'bg-saf-medium' : 'bg-saf-army'
                    }`}
                    style={{ width: `${Math.min(portStatus.channel_flow_pct || 0, 100)}%` }}
                  />
                </div>
              </div>
              <StatusRow
                label="Vessels Queued"
                indicator={portStatus.vessels_queued > 10 ? 'bg-saf-red' : 'bg-saf-army'}
                value={portStatus.vessels_queued != null ? portStatus.vessels_queued.toString() : 'N/A'}
              />
            </div>
          </div>
        )}

        {/* Collector Status */}
        <div className="pt-3 border-t border-gray-200">
          <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold mb-2">
            Collectors
          </h2>
          <div className="space-y-0.5">
            {Object.entries(COLLECTOR_LABELS).map(([key, label]) => {
              const c = collectors[key];
              if (!c) {
                return (
                  <StatusRow
                    key={key}
                    label={label}
                    indicator="bg-gray-400"
                    value="--"
                  />
                );
              }

              const ind = collectorIndicator(c.lastUpdate, key);
              const statusColor =
                c.status === 'active' ? 'bg-saf-army' :
                c.status === 'stale'  ? 'bg-saf-medium' :
                c.status === 'error'  ? 'bg-saf-red' :
                'bg-gray-400';

              return (
                <StatusRow
                  key={key}
                  label={label}
                  indicator={statusColor}
                  value={c.lastUpdate ? ind.label : (c.status === 'unavailable' ? 'N/A' : 'Waiting...')}
                />
              );
            })}
          </div>
        </div>

        {/* System Status inner */}
        <div className="pt-3 border-t border-gray-200">
          <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold mb-2">
            Connections
          </h2>

          <div className="space-y-0.5">
            <StatusRow
              label="WebSocket"
              indicator={wsConnected ? 'bg-saf-army' : 'bg-saf-red'}
              value={wsConnected ? 'Connected' : 'Disconnected'}
            />

            <StatusRow
              label="AI Provider"
              indicator={aiInfo.provider ? 'bg-saf-army' : 'bg-gray-400'}
              value={aiInfo.provider || 'None'}
            />

            <StatusRow
              label="AI Analysis"
              indicator={analysisFreshness.color}
              value={analysisFreshness.label}
            />

            <div className="border-t border-gray-100 my-1.5" />

            <div className="text-[10px] uppercase tracking-wider text-saf-mid font-medium mb-1">
              Database Counts
            </div>

            <StatusRow label="Vessels" indicator="bg-saf-navy" value={(dbCounts.vessels ?? vessels?.length ?? 0).toLocaleString()} />
            <StatusRow label="Flights" indicator="bg-saf-airforce" value={(dbCounts.flights ?? flights?.length ?? 0).toLocaleString()} />
            <StatusRow label="Weather" indicator="bg-saf-navy" value={(dbCounts.weather ?? 0).toLocaleString()} />
            <StatusRow label="Alerts" indicator="bg-saf-navy" value={(dbCounts.alerts ?? 0).toLocaleString()} />
            <StatusRow label="Analyses" indicator="bg-saf-navy" value={(dbCounts.analyses ?? 0).toLocaleString()} />
          </div>
        </div>
      </div>
    </div>
  );
}
