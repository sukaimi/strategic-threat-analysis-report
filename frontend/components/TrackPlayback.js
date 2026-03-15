'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const TRACK_COLORS = ['#22d3ee', '#f97316', '#e879f9', '#84cc16', '#facc15'];
const SPEEDS = [1, 2, 5, 10];

export { TRACK_COLORS };

export default function TrackPlayback({
  selectedEntities = [],
  tracksData = new Map(),
  playbackIndex = 0,
  totalFrames = 0,
  isPlaying = false,
  playbackSpeed = 1,
  timeRange = { from: '', to: '' },
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
  onRemoveEntity,
  onClearAll,
  onTimeRangeChange,
}) {
  // M20: Keyboard shortcuts
  useEffect(() => {
    if (selectedEntities.length === 0) return;

    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (isPlaying) {
          onPause?.();
        } else {
          onPlay?.();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (playbackIndex > 0) {
          onSeek?.(playbackIndex - 1);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (playbackIndex < totalFrames - 1) {
          onSeek?.(playbackIndex + 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEntities.length, isPlaying, playbackIndex, totalFrames, onPlay, onPause, onSeek]);

  if (selectedEntities.length === 0) return null;

  const progressPct = totalFrames > 0 ? (playbackIndex / (totalFrames - 1)) * 100 : 0;

  // M21: Get current timestamp from the first track that has data at this index
  let currentTimestamp = null;
  for (const entity of selectedEntities) {
    const id = entity.type === 'vessel' ? entity.mmsi : entity.callsign;
    const positions = tracksData.get(id);
    if (positions && positions.length > 0) {
      const ratio = totalFrames > 1 ? playbackIndex / (totalFrames - 1) : 0;
      const idx = Math.min(Math.round(ratio * (positions.length - 1)), positions.length - 1);
      if (positions[idx]?.recorded_at) {
        currentTimestamp = positions[idx].recorded_at;
        break;
      }
    }
  }

  const formatTimestamp = (ts) => {
    if (!ts) return null;
    try {
      const d = new Date(ts);
      return d.toLocaleString('en-SG', {
        timeZone: 'Asia/Singapore',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch (_) {
      return ts;
    }
  };

  return (
    <div className="absolute bottom-4 right-4 bg-[#1F1F1F]/95 border border-[#003A70]/60 rounded-lg px-4 py-3 backdrop-blur-sm z-[1000] w-80 font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-300 font-semibold tracking-wide text-[11px]">
          TRACK COMPARISON
        </span>
        <span className="text-gray-500">
          {selectedEntities.length}/5 tracks
        </span>
      </div>

      {/* Entity list */}
      <div className="space-y-1 mb-3 max-h-28 overflow-y-auto">
        {selectedEntities.map((entity, idx) => {
          const color = TRACK_COLORS[idx % TRACK_COLORS.length];
          const label = entity.type === 'vessel'
            ? (entity.name || entity.vessel_name || entity.mmsi || 'Unknown')
            : (entity.callsign || entity.flight_number || 'Unknown');
          const id = entity.type === 'vessel' ? entity.mmsi : entity.callsign;
          const trackLen = tracksData.get(id)?.length || 0;

          return (
            <div
              key={id}
              className="flex items-center justify-between bg-[#0a1628]/60 rounded px-2 py-1"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-gray-200 truncate">{label}</span>
                <span className="text-gray-500 shrink-0">{trackLen}pts</span>
              </div>
              <button
                onClick={() => onRemoveEntity?.(id)}
                className="text-gray-500 hover:text-red-400 ml-2 shrink-0 font-bold focus-visible:ring-2 focus-visible:ring-saf-airforce"
                title="Remove track"
              >
                x
              </button>
            </div>
          );
        })}
      </div>

      {/* Time range */}
      <div className="flex gap-2 mb-2">
        <div className="flex-1">
          <label className="text-gray-500 text-[9px] block mb-0.5">FROM</label>
          <input
            type="datetime-local"
            value={timeRange.from}
            onChange={(e) => onTimeRangeChange?.({ ...timeRange, from: e.target.value })}
            className="w-full bg-[#0a1628] border border-[#003A70]/40 rounded px-1.5 py-0.5 text-gray-300 text-[10px]"
          />
        </div>
        <div className="flex-1">
          <label className="text-gray-500 text-[9px] block mb-0.5">TO</label>
          <input
            type="datetime-local"
            value={timeRange.to}
            onChange={(e) => onTimeRangeChange?.({ ...timeRange, to: e.target.value })}
            className="w-full bg-[#0a1628] border border-[#003A70]/40 rounded px-1.5 py-0.5 text-gray-300 text-[10px]"
          />
        </div>
      </div>

      {/* Progress bar */}
      {totalFrames > 1 && (
        <div className="mb-2">
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            value={playbackIndex}
            onChange={(e) => onSeek?.(Number(e.target.value))}
            className="w-full h-1 accent-cyan-400"
          />
          <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
            {/* M21: Show actual datetime instead of frame number */}
            <span>{currentTimestamp ? formatTimestamp(currentTimestamp) : `Frame ${playbackIndex + 1}`}</span>
            <span>{totalFrames} total</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Play / Pause */}
          <button
            onClick={isPlaying ? onPause : onPlay}
            className="text-gray-200 hover:text-cyan-400 bg-[#003A70]/40 rounded px-2 py-1 text-[10px] font-semibold focus-visible:ring-2 focus-visible:ring-saf-airforce"
            disabled={totalFrames < 2}
          >
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </button>

          {/* Speed */}
          <div className="flex items-center gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => onSpeedChange?.(s)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-semibold focus-visible:ring-2 focus-visible:ring-saf-airforce ${
                  playbackSpeed === s
                    ? 'bg-cyan-600 text-white'
                    : 'bg-[#003A70]/30 text-gray-400 hover:text-gray-200'
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>

        {/* Clear all */}
        <button
          onClick={onClearAll}
          className="text-gray-500 hover:text-red-400 text-[10px] font-semibold focus-visible:ring-2 focus-visible:ring-saf-airforce"
        >
          CLEAR ALL
        </button>
      </div>

      {/* M20: Keyboard shortcut hint */}
      <div className="text-[8px] text-gray-600 mt-2 text-center">
        Space: play/pause | Arrow keys: step
      </div>
    </div>
  );
}
