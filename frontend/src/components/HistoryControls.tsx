// ── HistoryControls: compact inline summary + playback bar ───────────────────

import React from 'react';
import type { HistoryPlayback } from '../hooks/useHistoryPlayback.ts';

interface HistoryControlsProps {
  hp:           HistoryPlayback;
  onOpenConfig: () => void;
}

/** Format nanoseconds as a short locale date + time string. */
function formatNs(ns: number): string {
  if (!ns) return '—';
  return new Date(ns / 1_000_000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour:  '2-digit', minute: '2-digit',
  });
}

export default function HistoryControls({ hp, onOpenConfig }: HistoryControlsProps) {
  const {
    range, filters, setFilters,
    traces, isLoading, loadTraces,
    cursorNs, cursorIndex,
    playing,
    play, pause, reset, stepBack, stepForward, stepTo,
  } = hp;

  const hasRange  = !!(range.from || range.to);
  const hasTraces = traces.length > 0;

  const canStepBack    = hasTraces && !playing && cursorIndex > -1;
  const canStepForward = hasTraces && !playing && cursorIndex < traces.length - 1;

  return (
    <div id="history-controls">

      {/* ── Row 1: summary + filter chips + actions ── */}
      <div className="hc-row hc-summary-row">
        {/* Range summary */}
        <span className="hc-range-summary">
          {hasRange
            ? <>{formatNs(range.from)}<span className="hc-range-sep">→</span>{formatNs(range.to)}</>
            : <span className="hc-range-empty">No range set</span>
          }
        </span>

        {/* Active filter chips */}
        {filters.service && (
          <span className="hc-chip">
            service: {filters.service}
            <button
              className="hc-chip-remove"
              aria-label="Remove service filter"
              onClick={() => setFilters({ ...filters, service: '' })}
            >✕</button>
          </span>
        )}
        {filters.minDurationMs && (
          <span className="hc-chip">
            ≥{filters.minDurationMs}ms
            <button
              className="hc-chip-remove"
              aria-label="Remove min duration filter"
              onClick={() => setFilters({ ...filters, minDurationMs: '' })}
            >✕</button>
          </span>
        )}
        {filters.maxDurationMs && (
          <span className="hc-chip">
            ≤{filters.maxDurationMs}ms
            <button
              className="hc-chip-remove"
              aria-label="Remove max duration filter"
              onClick={() => setFilters({ ...filters, maxDurationMs: '' })}
            >✕</button>
          </span>
        )}

        {/* Count badge */}
        {hasTraces && (
          <span className="hc-badge">{traces.length.toLocaleString()} traces</span>
        )}
        {isLoading && <span className="hc-loading-dot" />}

        <div className="hc-spacer" />

        {/* Inline load (when no traces loaded yet) */}
        {!hasTraces && (
          <button
            className="hc-load-btn"
            onClick={() => loadTraces()}
            disabled={isLoading || !hasRange}
            title="Load traces for the current range"
          >
            {isLoading ? 'Loading…' : 'Load'}
          </button>
        )}

        {/* Configure button */}
        <button className="hc-configure-btn" onClick={onOpenConfig} title="Configure history range and filters">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="6" cy="6" r="1.8" />
            <path d="M6 1v1.2M6 9.8V11M11 6H9.8M2.2 6H1M9.19 2.81l-.85.85M3.66 8.34l-.85.85M9.19 9.19l-.85-.85M3.66 3.66l-.85-.85" />
          </svg>
          Configure
        </button>
      </div>

      {/* ── Row 2: playback ── */}
      <div className="hc-row hc-playback-row">
        <button className="hc-ctrl-btn" title="Reset to start" onClick={reset} disabled={!hasTraces || playing}>⏮</button>
        <button className="hc-ctrl-btn" title="Step back one trace" onClick={stepBack} disabled={!canStepBack}>◀</button>
        <button className="hc-ctrl-btn hc-play-btn" onClick={playing ? pause : play} title={playing ? 'Pause' : 'Play'} disabled={!hasTraces}>
          {playing ? '⏸' : '▶'}
        </button>
        <button className="hc-ctrl-btn" title="Step forward one trace" onClick={stepForward} disabled={!canStepForward}>▶</button>

        <input
          type="range"
          className="hc-scrubber"
          min={0}
          max={Math.max(0, traces.length - 1)}
          step={1}
          value={Math.max(0, cursorIndex)}
          onChange={e => stepTo(Number(e.target.value))}
          disabled={!hasTraces}
        />

        <span className="hc-cursor-time">
          {hasTraces
            ? (cursorIndex < 0
                ? <span className="hc-range-empty">press play or step to start</span>
                : <>{formatNs(cursorNs)} <span className="hc-trace-idx">{cursorIndex + 1}/{traces.length}</span></>
              )
            : '—'
          }
        </span>

        <button
          className="hc-configure-btn hc-configure-btn-sm"
          onClick={onOpenConfig}
          title="Configure range and filters"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="6" cy="6" r="1.8" />
            <path d="M6 1v1.2M6 9.8V11M11 6H9.8M2.2 6H1M9.19 2.81l-.85.85M3.66 8.34l-.85.85M9.19 9.19l-.85-.85M3.66 3.66l-.85-.85" />
          </svg>
        </button>
      </div>
    </div>
  );
}
