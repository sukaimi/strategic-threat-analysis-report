'use client';

import { useState, useEffect } from 'react';

const API_HEADERS = process.env.NEXT_PUBLIC_API_KEY
  ? { 'x-api-key': process.env.NEXT_PUBLIC_API_KEY }
  : {};

function scoreColor(score) {
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

export default function ThreatTrend() {
  const [history, setHistory] = useState([]);

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
  const latestColor = scoreColor(latest.score);

  return (
    <div className="saf-card m-3">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold">
          Threat Trend (24h)
        </h2>
        <span className="text-[11px] text-saf-mid font-semibold">
          {history.length} samples
        </span>
      </div>

      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
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

        {/* Area fill */}
        <path d={areaPath} fill={`${latestColor}18`} />

        {/* Line */}
        <path d={linePath} fill="none" stroke={latestColor} strokeWidth="1.5" />

        {/* Latest point */}
        <circle cx={latest.x} cy={latest.y} r="2.5" fill={latestColor} />
      </svg>

      {/* Time labels */}
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
