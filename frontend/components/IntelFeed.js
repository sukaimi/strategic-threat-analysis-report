'use client';

import { useState, useEffect } from 'react';

const RELEVANCE_CONFIG = {
  critical: { bg: 'bg-saf-red', text: 'text-saf-red', label: 'CRITICAL' },
  relevant: { bg: 'bg-saf-medium', text: 'text-saf-medium', label: 'RELEVANT' },
  low: { bg: 'bg-saf-army', text: 'text-saf-army', label: 'LOW' },
};

function getRelevanceConfig(score) {
  if (score >= 70) return RELEVANCE_CONFIG.critical;
  if (score >= 40) return RELEVANCE_CONFIG.relevant;
  return RELEVANCE_CONFIG.low;
}

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

function parseEntities(entitiesJson) {
  if (!entitiesJson) return [];
  if (Array.isArray(entitiesJson)) return entitiesJson;
  try {
    const parsed = JSON.parse(entitiesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

const FILTERS = [
  { key: 'all', label: 'All', min: 0 },
  { key: 'critical', label: 'Critical', min: 70 },
  { key: 'relevant', label: 'Relevant', min: 40 },
];

export default function IntelFeed({ articles = [], collapsed = false, onToggle }) {
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const timeAgo = useTimeAgo();

  const filtered = articles.filter((a) => {
    const score = a.relevance_score ?? 0;
    const filterConfig = FILTERS.find((f) => f.key === filter);
    if (score < (filterConfig?.min ?? 0)) return false;

    // M19: Text search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const title = (a.title || '').toLowerCase();
      const entities = parseEntities(a.entities_json);
      const entityText = entities.map((e) =>
        typeof e === 'string' ? e : (e.name || e.value || '')
      ).join(' ').toLowerCase();
      if (!title.includes(q) && !entityText.includes(q)) return false;
    }

    return true;
  });

  return (
    <div className="saf-card m-3">
      <button
        className="flex items-center justify-between w-full mb-3 focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <h2 className="text-xs uppercase tracking-widest text-saf-mid font-semibold">
          Intel Feed
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-saf-mid font-semibold">
            {filtered.length} total
          </span>
          <span className={`text-xs text-saf-mid transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}>
            &#9650;
          </span>
        </div>
      </button>

      <div
        className={`transition-all duration-300 overflow-hidden ${collapsed ? 'max-h-0' : 'max-h-[2000px]'}`}
      >
        {/* M19: Search input */}
        <div className="mb-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search articles..."
            className="w-full bg-gray-100 border border-gray-200 rounded px-2.5 py-1.5 text-xs text-saf-dark placeholder-saf-mid focus:outline-none focus:ring-2 focus:ring-saf-airforce"
          />
        </div>

        {/* Filter buttons */}
        <div className="flex gap-1.5 mb-3">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-saf-airforce ${
                filter === f.key
                  ? 'bg-saf-navy text-white'
                  : 'bg-gray-200 text-saf-mid hover:bg-gray-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="text-saf-mid text-sm text-center py-4">
            No intelligence reports available
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {filtered.map((article, idx) => {
              const score = article.relevance_score ?? 0;
              const config = getRelevanceConfig(score);
              const isExpanded = expandedId === (article.id ?? idx);
              const entities = parseEntities(article.entities_json);

              return (
                <div
                  key={article.id ?? `intel-${idx}`}
                  className="rounded border-l-3 border-saf-navy bg-saf-light p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span
                          className={`${config.bg} text-white text-[9px] font-bold px-1.5 py-0.5 rounded uppercase`}
                        >
                          {Math.round(score)}
                        </span>
                        {article.source && (
                          <span className="text-[9px] font-semibold text-saf-navy bg-blue-100 px-1.5 py-0.5 rounded">
                            {article.source}
                          </span>
                        )}
                        <span className="text-[10px] text-saf-mid font-medium">
                          {timeAgo(article.published_at || article.created_at)}
                        </span>
                      </div>
                      {/* H10: Changed from div to button for accessibility */}
                      <button
                        className="text-sm text-saf-dark cursor-pointer hover:text-saf-navy transition-colors font-medium min-h-[44px] flex items-center text-left w-full focus-visible:ring-2 focus-visible:ring-saf-airforce rounded"
                        onClick={() => setExpandedId(isExpanded ? null : (article.id ?? idx))}
                        aria-expanded={isExpanded}
                      >
                        {article.title || 'Untitled Report'}
                      </button>
                      {isExpanded && (
                        <div className="mt-1.5">
                          {article.summary && (
                            <p className="text-[12px] text-saf-mid leading-relaxed mb-2">
                              {article.summary}
                            </p>
                          )}
                          {entities.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-2">
                              {entities.map((entity, eIdx) => (
                                <span
                                  key={eIdx}
                                  className="text-[9px] font-medium text-saf-dark bg-gray-200 px-1.5 py-0.5 rounded"
                                >
                                  {typeof entity === 'string' ? entity : entity.name || entity.value || JSON.stringify(entity)}
                                </span>
                              ))}
                            </div>
                          )}
                          {article.link && (
                            <a
                              href={article.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="saf-btn-secondary text-[9px] uppercase tracking-wider px-2 py-1 inline-flex items-center min-h-[44px] focus-visible:ring-2 focus-visible:ring-saf-airforce"
                            >
                              Read Source
                            </a>
                          )}
                        </div>
                      )}
                    </div>
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
