'use client';

import { useState, useEffect } from 'react';

const API_HEADERS = process.env.NEXT_PUBLIC_API_KEY
  ? { 'x-api-key': process.env.NEXT_PUBLIC_API_KEY }
  : {};

const MERLION_CATEGORIES = [
  { key: 'maritime_security', label: 'Maritime Security' },
  { key: 'navigation_safety', label: 'Navigation Safety' },
  { key: 'port_congestion', label: 'Port Congestion' },
  { key: 'weather_risk', label: 'Weather Risk' },
  { key: 'airspace_activity', label: 'Airspace Activity' },
];

const DJINN_CATEGORIES = [
  { key: 'maritime_security', label: 'Maritime Security' },
  { key: 'navigation_safety', label: 'Navigation Safety' },
  { key: 'energy_flow_security', label: 'Energy Flow Security' },
  { key: 'sanctions_evasion', label: 'Sanctions Evasion' },
  { key: 'weather_risk', label: 'Weather Risk' },
  { key: 'airspace_activity', label: 'Airspace Activity' },
];

function scoreColor(score) {
  if (score >= 80) return 'bg-saf-red';
  if (score >= 60) return 'bg-saf-high';
  if (score >= 30) return 'bg-saf-medium';
  return 'bg-saf-army';
}

function scoreTextColor(score) {
  if (score >= 80) return 'text-saf-red';
  if (score >= 60) return 'text-saf-high';
  if (score >= 30) return 'text-saf-medium';
  return 'text-saf-army';
}

function scoreHexColor(score) {
  if (score >= 80) return '#C8102E';
  if (score >= 60) return '#D4580A';
  if (score >= 30) return '#B8860B';
  return '#4F5B3A';
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-SG', {
    timeZone: 'Asia/Singapore',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// M13: Inline ThreatTrend sub-component with hover tooltip
function ThreatTrendInline() {
  const [history, setHistory] = useState([]);
  const [hoverPoint, setHoverPoint] = useState(null);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await fetch('/api/analyses/history', { headers: API_HEADERS });
        if (!res.ok) return;
        const rows = await res.json();
        const points = rows.map((r) => {
          let score = r.composite_score;
          if (score == null && r.threat_json) {
            try {
              const parsed = JSON.parse(r.threat_json);
              score = parsed.composite_score ?? parsed.compositeScore ?? 0;
            } catch (_) {
              score = 0;
            }
          }
          return { score: score ?? 0, time: r.recorded_at };
        }).reverse();
        setHistory(points);
      } catch (_) {}
    };

    fetchHistory();
    const interval = setInterval(fetchHistory, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (history.length < 2) return null;

  const W = 240;
  const H = 48;
  const PAD = 2;
  const maxScore = 100;

  const points = history.map((p, i) => ({
    x: PAD + (i / (history.length - 1)) * (W - PAD * 2),
    y: PAD + ((maxScore - p.score) / maxScore) * (H - PAD * 2),
    score: p.score,
    time: p.time,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = linePath + ` L${points[points.length - 1].x},${H} L${points[0].x},${H} Z`;
  const latest = points[points.length - 1];
  const latestColor = scoreHexColor(latest.score);

  const handleMouseMove = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * W;

    let closest = points[0];
    let closestDist = Infinity;
    for (const p of points) {
      const dist = Math.abs(p.x - mouseX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = p;
      }
    }
    setHoverPoint(closest);
  };

  return (
    <div className="pt-2 border-t border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-saf-mid font-semibold">
          Threat Trend (24h)
        </div>
        <span className="text-[11px] text-saf-mid font-semibold">
          {history.length} samples
        </span>
      </div>

      <div className="relative">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverPoint(null)}
        >
          {/* Threshold lines */}
          {[30, 60, 80].map((threshold) => {
            const y = PAD + ((maxScore - threshold) / maxScore) * (H - PAD * 2);
            return (
              <line
                key={threshold}
                x1={PAD} y1={y} x2={W - PAD} y2={y}
                stroke="#E5E7EB" strokeWidth="0.5" strokeDasharray="2,3"
              />
            );
          })}
          <path d={areaPath} fill={`${latestColor}18`} />
          <path d={linePath} fill="none" stroke={latestColor} strokeWidth="1.5" />
          <circle cx={latest.x} cy={latest.y} r="2.5" fill={latestColor} />
          {/* M13: Hover indicator */}
          {hoverPoint && (
            <>
              <line x1={hoverPoint.x} y1={0} x2={hoverPoint.x} y2={H} stroke="#4A90E2" strokeWidth="0.5" strokeDasharray="2,2" />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="3" fill={scoreHexColor(hoverPoint.score)} stroke="white" strokeWidth="1" />
            </>
          )}
        </svg>
        {/* M13: Tooltip */}
        {hoverPoint && (
          <div
            className="absolute bg-saf-dark text-white text-[10px] px-2 py-1 rounded shadow-lg pointer-events-none font-mono z-10"
            style={{
              left: `${(hoverPoint.x / W) * 100}%`,
              top: '-28px',
              transform: 'translateX(-50%)',
            }}
          >
            Score: {Math.round(hoverPoint.score)} | {formatTime(hoverPoint.time)}
          </div>
        )}
      </div>

      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-saf-mid font-medium">
          {formatTime(history[0].time)}
        </span>
        <span className="text-[10px] text-saf-mid font-medium">
          {formatTime(history[history.length - 1].time)}
        </span>
      </div>
    </div>
  );
}

export default function ThreatPanel({ analysis, onFocusVessel, collapsed = false, onToggle, theaterKey = 'merlion' }) {
  if (!analysis) {
    return (
      <div className="saf-card m-3">
        <button
          className="flex items-center justify-between w-full mb-3 focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold">
            Threat Assessment
          </h2>
          <span className={`text-xs text-saf-mid transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}>
            &#9650;
          </span>
        </button>
        <div
          className={`transition-all duration-300 overflow-hidden ${collapsed ? 'max-h-0' : 'max-h-[2000px]'}`}
        >
          <div className="text-saf-mid text-sm text-center py-6">
            Awaiting analysis data...
          </div>
        </div>
      </div>
    );
  }

  const compositeScore = analysis.composite_score ?? analysis.compositeScore ?? 0;
  const categories = analysis.category_scores ?? analysis.categoryScores ?? {};
  const brief = analysis.tactical_brief ?? analysis.tacticalBrief ?? '';
  const forecast6h = analysis.forecast_6h ?? analysis.forecast6h ?? '';
  const forecast24h = analysis.forecast_24h ?? analysis.forecast24h ?? '';
  const keyFindings = analysis.key_findings ?? analysis.keyFindings ?? [];
  const priorityActions = analysis.priority_actions ?? analysis.priorityActions ?? [];
  const vesselAnomalies = analysis.vessel_anomalies ?? analysis.vesselAnomalies ?? [];

  return (
    <div className="saf-card m-3">
      <button
        className="flex items-center justify-between w-full mb-3 focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold">
          Threat Assessment
        </h2>
        <span className={`text-xs text-saf-mid transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}>
          &#9650;
        </span>
      </button>

      <div
        className={`transition-all duration-300 overflow-hidden ${collapsed ? 'max-h-0' : 'max-h-[5000px]'}`}
      >
        {/* Composite Score */}
        <div className="flex items-center gap-3 lg:gap-4 mb-4">
          <div className={`text-3xl lg:text-4xl font-bold ${scoreTextColor(compositeScore)}`}>
            {Math.round(compositeScore)}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-saf-mid leading-tight">
              Composite<br />Threat Score
            </div>
            <div className={`text-xs font-bold mt-0.5 ${scoreTextColor(compositeScore)}`}>
              {analysis.threat_level || analysis.threatLevel || 'LOW'}
            </div>
          </div>
        </div>

        {/* Category Bars */}
        <div className="space-y-2.5 mb-4">
          {(theaterKey === 'djinn' ? DJINN_CATEGORIES : MERLION_CATEGORIES).map(({ key, label }) => {
            const score = categories[key] ?? 0;
            return (
              <div key={key}>
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-saf-dark font-medium">{label}</span>
                  <span className="text-saf-mid font-semibold">{Math.round(score)}</span>
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full bar-fill ${scoreColor(score)}`}
                    style={{ width: `${Math.min(score, 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Tactical Brief */}
        {brief && (
          <div className="mb-3">
            <div className="text-[11px] uppercase tracking-wider text-saf-mid font-semibold mb-1">
              Tactical Brief
            </div>
            <p className="text-sm text-saf-dark leading-relaxed">{brief}</p>
          </div>
        )}

        {/* Key Findings */}
        {keyFindings.length > 0 && (
          <div className="mb-3">
            <div className="text-[11px] uppercase tracking-wider text-saf-mid font-semibold mb-1">
              Key Findings
            </div>
            <ul className="space-y-1">
              {keyFindings.map((finding, i) => (
                <li key={i} className="flex gap-2 text-sm text-saf-dark leading-relaxed">
                  <span className="text-saf-navy shrink-0 font-bold">&#x25B8;</span>
                  <span>{finding}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Priority Actions */}
        {priorityActions.length > 0 && (
          <div className="mb-3">
            <div className="text-[11px] uppercase tracking-wider text-saf-red font-semibold mb-1">
              Priority Actions
            </div>
            <ul className="space-y-1">
              {priorityActions.map((action, i) => (
                <li key={i} className="flex gap-2 text-sm text-saf-dark leading-relaxed">
                  <span className="text-saf-red shrink-0 font-bold">{i + 1}.</span>
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Vessel Anomalies — H10: Changed to button elements */}
        {vesselAnomalies.length > 0 && (
          <div className="mb-3">
            <div className="text-[11px] uppercase tracking-wider text-saf-red font-semibold mb-1">
              Vessel Anomalies
            </div>
            <div className="space-y-1.5">
              {vesselAnomalies.map((v, i) => (
                <button
                  key={i}
                  role="button"
                  tabIndex={0}
                  className="flex items-start gap-2 bg-red-50 rounded px-2.5 py-2 lg:py-1.5 border-l-2 border-saf-red cursor-pointer hover:bg-red-100 transition-colors min-h-[44px] w-full text-left focus-visible:ring-2 focus-visible:ring-saf-airforce"
                  onClick={() => onFocusVessel?.(v.mmsi)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusVessel?.(v.mmsi); } }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-saf-red">{v.mmsi}</div>
                    <div className="text-[11px] text-saf-mid leading-tight">{v.reason}</div>
                  </div>
                  <span className="text-[9px] text-saf-navy font-semibold shrink-0 self-center">LOCATE</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Forecasts */}
        {(forecast6h || forecast24h) && (
          <div className="space-y-2 pt-2 border-t border-gray-200">
            {forecast6h && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-saf-mid font-semibold mb-0.5">
                  6h Forecast
                </div>
                <p className="text-[12px] text-saf-mid leading-relaxed">{forecast6h}</p>
              </div>
            )}
            {forecast24h && (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-saf-mid font-semibold mb-0.5">
                  24h Forecast
                </div>
                <p className="text-[12px] text-saf-mid leading-relaxed">{forecast24h}</p>
              </div>
            )}
          </div>
        )}

        {/* M14: Merged ThreatTrend inline */}
        <ThreatTrendInline />
      </div>
    </div>
  );
}
