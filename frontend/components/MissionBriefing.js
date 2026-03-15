'use client';

import { useState } from 'react';

export default function MissionBriefing({ collapsed = false, onToggle }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-t border-gray-200">
      <button
        onClick={() => {
          if (collapsed && onToggle) {
            onToggle();
          } else {
            setExpanded(!expanded);
          }
        }}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50 transition-colors focus-visible:ring-2 focus-visible:ring-saf-airforce"
      >
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-saf-navy rounded-full" />
          <span className="text-xs font-bold tracking-widest text-saf-navy uppercase">
            STAR Briefing
          </span>
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            Codename MERLION
          </span>
        </div>
        <span className="text-xs text-gray-400">{expanded && !collapsed ? '\u25B2' : '\u25BC'}</span>
      </button>

      <div
        className={`transition-all duration-300 overflow-hidden ${collapsed ? 'max-h-0' : expanded ? 'max-h-[2000px]' : 'max-h-0'}`}
      >
        <div className="px-4 pb-4 max-h-96 overflow-y-auto text-xs text-gray-700 space-y-4">
          {/* System Overview */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              1. System Overview
            </h3>
            <p>
              STAR (Strategic Threat Analysis Report) is an AI-native intelligence system
              that ingests and analyses publicly available maritime, aviation, meteorological,
              and port operations data across the Singapore Strait and surrounding regional
              waters. Internal codename: <strong>MERLION</strong>.
            </p>
          </section>

          {/* Mission Objective */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              2. Mission Objective
            </h3>
            <p>
              Provide persistent, automated situational awareness of the Singapore Strait.
              Detect maritime security anomalies (AIS-dark behaviour, loitering, speed
              deviations), navigation safety hazards, port congestion, weather risks, and
              airspace activity correlation.
            </p>
          </section>

          {/* Operating Domain */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              3. Operating Domain
            </h3>
            <ul className="list-none space-y-0.5 text-gray-600">
              <li><strong>Primary AOR:</strong> 1.0{'\u00b0'}N{'\u2013'}1.5{'\u00b0'}N, 103.5{'\u00b0'}E{'\u2013'}104.5{'\u00b0'}E (Singapore Strait)</li>
              <li><strong>Extended AOR:</strong> Southern Johor, Batam, Bintan, Karimun Islands</li>
              <li><strong>Regional:</strong> Malacca Strait, South China Sea</li>
              <li><strong>Airspace:</strong> 150km radius from Singapore</li>
            </ul>
          </section>

          {/* Data Inputs */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              4. Data Inputs
            </h3>
            <ul className="list-none space-y-0.5 text-gray-600">
              <li><strong>MPA OCEANS-X</strong> {'\u2014'} Official vessel positions (3-min cycle)</li>
              <li><strong>AIS</strong> {'\u2014'} Real-time vessel tracking (continuous)</li>
              <li><strong>ADS-B</strong> {'\u2014'} Aircraft positions (15s polling)</li>
              <li><strong>Open-Meteo + NEA</strong> {'\u2014'} Weather data (15-min cycle)</li>
              <li><strong>Port metrics</strong> {'\u2014'} Berth utilisation, queue depth (5-min cycle)</li>
            </ul>
          </section>

          {/* Analytical Functions */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              5. Analytical Functions
            </h3>
            <ul className="list-none space-y-0.5 text-gray-600">
              <li><strong>Signal Detection</strong> {'\u2014'} AIS-dark, speed anomalies, loitering, formations</li>
              <li><strong>Anomaly Detection</strong> {'\u2014'} Baseline comparison via 72h database + vault history</li>
              <li><strong>Threat Scoring</strong> {'\u2014'} Composite 0{'\u2013'}100 across 5 categories</li>
              <li><strong>Trend Analysis</strong> {'\u2014'} 5-min cycles, 6h/24h forecasts, daily/weekly summaries</li>
              <li><strong>Event Correlation</strong> {'\u2014'} Cross-domain maritime/aviation/weather pattern matching</li>
            </ul>
          </section>

          {/* Output Products */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              6. Output Products
            </h3>
            <ul className="list-none space-y-0.5 text-gray-600">
              <li><strong>STAR Reports</strong> {'\u2014'} Structured threat assessments every 5 minutes</li>
              <li><strong>Alerts</strong> {'\u2014'} Real-time severity-coded notifications (CRITICAL/HIGH/MEDIUM/LOW)</li>
              <li><strong>Situational Summaries</strong> {'\u2014'} Daily and weekly aggregated intelligence</li>
              <li><strong>Vault Records</strong> {'\u2014'} Incident logs, vessel observations, identified patterns</li>
            </ul>
          </section>

          {/* Threat Levels */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              7. Threat Classification
            </h3>
            <div className="grid grid-cols-2 gap-1 text-gray-600">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-saf-red" />
                <span>CRITICAL (80{'\u2013'}100)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-saf-high" />
                <span>HIGH (60{'\u2013'}79)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-saf-medium" />
                <span>MEDIUM (30{'\u2013'}59)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-saf-army" />
                <span>LOW (0{'\u2013'}29)</span>
              </div>
            </div>
          </section>

          {/* Architecture */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              8. System Architecture
            </h3>
            <p className="text-gray-600 font-mono text-[10px] leading-relaxed whitespace-pre">
{`Ingestion \u2192 Signal Detection \u2192 AI Analysis \u2192 Threat Scoring \u2192 Report Gen \u2192 Dissemination
   MPA        Anomaly flags      DeepSeek V3    Composite 0-100   STAR report   WebSocket
   AIS        Speed deviations   Gemini 2.0     Category scores   Alerts        Dashboard
   ADS-B      AIS-dark events    Ollama/Llama   Level classify    Vault write   Alert feed
   Weather    Baseline compare   Circuit break  6h/24h forecast   Summaries     API`}
            </p>
          </section>

          {/* Intended Users */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              9. Intended Users
            </h3>
            <ul className="list-none space-y-0.5 text-gray-600">
              <li>Intelligence analysts, maritime monitoring teams, command staff, AI agents, system engineers</li>
            </ul>
          </section>

          {/* Limitations */}
          <section>
            <h3 className="font-bold text-saf-navy uppercase tracking-wider text-[11px] mb-1">
              10. Limitations
            </h3>
            <ul className="list-none space-y-0.5 text-gray-600">
              <li>{'\u2022'} Open-source data only {'\u2014'} no classified feeds</li>
              <li>{'\u2022'} AIS is self-reported and can be spoofed or disabled</li>
              <li>{'\u2022'} AI models may produce false positives or inconsistent scores</li>
              <li>{'\u2022'} 72-hour operational window; long-term analysis via vault only</li>
            </ul>
          </section>

          {/* Footer */}
          <div className="pt-2 border-t border-gray-200 text-[10px] text-gray-400 uppercase tracking-wider">
            STAR v2.0.0 {'\u2014'} Internal {'\u2014'} Restricted Distribution
          </div>
        </div>
      </div>
    </div>
  );
}
