'use client';

import { useState, useEffect, useRef } from 'react';

const SEVERITY_CONFIG = {
  CRITICAL: { bg: 'bg-saf-red', text: 'text-saf-red', border: 'border-saf-red' },
  HIGH: { bg: 'bg-saf-high', text: 'text-saf-high', border: 'border-saf-high' },
  MEDIUM: { bg: 'bg-saf-medium', text: 'text-saf-medium', border: 'border-saf-medium' },
  LOW: { bg: 'bg-saf-army', text: 'text-saf-army', border: 'border-saf-army' },
};

const SEVERITY_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'CRITICAL', label: 'Critical' },
  { key: 'HIGH', label: 'High' },
  { key: 'MEDIUM', label: 'Medium' },
  { key: 'LOW', label: 'Low' },
];

function useTimeAgo() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  return (timestamp) => {
    if (!timestamp) return '';
    const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };
}

export default function AlertsFeed({ alerts = [], onAcknowledge, onFocusVessel, collapsed = false, onToggle }) {
  const [expandedId, setExpandedId] = useState(null);
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [recentIds, setRecentIds] = useState(new Set());
  const prevAlertIdsRef = useRef(new Set());
  const timeAgo = useTimeAgo();

  // M12: Track recently arrived alert IDs
  useEffect(() => {
    const currentIds = new Set(alerts.map((a) => a.id).filter(Boolean));
    const newIds = [];
    for (const id of currentIds) {
      if (!prevAlertIdsRef.current.has(id)) {
        newIds.push(id);
      }
    }
    prevAlertIdsRef.current = currentIds;

    if (newIds.length > 0) {
      setRecentIds((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => next.add(id));
        return next;
      });

      const timer = setTimeout(() => {
        setRecentIds((prev) => {
          const next = new Set(prev);
          newIds.forEach((id) => next.delete(id));
          return next;
        });
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [alerts]);

  // H3: Filter alerts by severity
  const filtered = alerts.filter((alert) => {
    if (severityFilter === 'ALL') return true;
    return (alert.severity || 'LOW').toUpperCase() === severityFilter;
  });

  // M16: Batch acknowledge
  const handleAckAll = () => {
    if (!onAcknowledge) return;
    alerts.forEach((alert) => {
      if (!alert.acknowledged && (alert.severity || 'LOW').toUpperCase() !== 'CRITICAL' && alert.id) {
        onAcknowledge(alert.id);
      }
    });
  };

  return (
    <div className="saf-card m-3">
      <button
        className="flex items-center justify-between w-full mb-3 focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold">
          Alerts Feed
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-saf-mid font-semibold">
            {alerts.length} total
          </span>
          <span className={`text-xs text-saf-mid transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}>
            &#9650;
          </span>
        </div>
      </button>

      <div
        className={`transition-all duration-300 overflow-hidden ${collapsed ? 'max-h-0' : 'max-h-[2000px]'}`}
      >
        {/* H3: Severity filter buttons */}
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {SEVERITY_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setSeverityFilter(f.key)}
              className={`text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-saf-airforce ${
                severityFilter === f.key
                  ? 'bg-saf-navy text-white'
                  : 'bg-gray-200 text-saf-mid hover:bg-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
          {/* M16: ACK ALL button */}
          {onAcknowledge && (
            <button
              onClick={handleAckAll}
              className="text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1.5 rounded transition-colors bg-saf-army/20 text-saf-army hover:bg-saf-army/40 ml-auto focus-visible:ring-2 focus-visible:ring-saf-airforce"
            >
              ACK ALL
            </button>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="text-saf-mid text-sm text-center py-4">
            No active alerts
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {filtered.map((alert, idx) => {
              const severity = (alert.severity || 'LOW').toUpperCase();
              const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.LOW;
              const isExpanded = expandedId === (alert.id ?? idx);
              const hasMmsi = alert.entity_mmsi || alert.entityMmsi;
              const isRecent = alert.id && recentIds.has(alert.id);

              return (
                <div
                  key={alert.id ?? `alert-${idx}`}
                  className={`rounded border-l-3 ${config.border} bg-saf-light p-2.5 ${
                    alert.acknowledged ? 'opacity-50' : ''
                  } ${isRecent ? 'animate-pulse border-l-4 border-saf-red' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span
                          className={`${config.bg} text-white text-[9px] font-bold px-1.5 py-0.5 rounded uppercase`}
                        >
                          {severity}
                        </span>
                        <span className="text-[10px] text-saf-mid font-medium">
                          {timeAgo(alert.created_at || alert.createdAt || alert.timestamp)}
                        </span>
                        {hasMmsi && (
                          <button
                            onClick={() => onFocusVessel?.(hasMmsi)}
                            className="text-[9px] text-saf-navy hover:text-saf-dark transition-colors font-semibold min-h-[44px] min-w-[44px] flex items-center justify-center lg:min-h-0 lg:min-w-0 focus-visible:ring-2 focus-visible:ring-saf-airforce"
                          >
                            [{hasMmsi}]
                          </button>
                        )}
                      </div>
                      {/* H10: Changed from div to button for accessibility */}
                      <button
                        className="text-sm text-saf-dark cursor-pointer hover:text-saf-navy transition-colors font-medium text-left w-full focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
                        onClick={() => setExpandedId(isExpanded ? null : (alert.id ?? idx))}
                        aria-expanded={isExpanded}
                      >
                        {alert.title || alert.message || 'Alert'}
                      </button>
                      {isExpanded && alert.description && (
                        <p className="text-[12px] text-saf-mid mt-1 leading-relaxed">
                          {alert.description}
                        </p>
                      )}
                    </div>

                    {!alert.acknowledged && onAcknowledge && (
                      <button
                        onClick={() => onAcknowledge(alert.id)}
                        className="saf-btn-secondary shrink-0 text-[9px] uppercase tracking-wider px-2 py-0.5 min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-saf-airforce"
                      >
                        ACK
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
