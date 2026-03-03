// ── HistoryConfigDialog: time range, filters, and load for history mode ───────

import React, { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { HistoryPlayback, HistoryFilters } from '../hooks/useHistoryPlayback.ts';

interface HistoryConfigDialogProps {
  open:    boolean;
  onClose: () => void;
  hp:      HistoryPlayback;
}

/** Convert nanoseconds to a datetime-local input value string. */
function nsToDatetimeLocal(ns: number): string {
  if (!ns) return '';
  const d   = new Date(ns / 1_000_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToNs(s: string): number {
  if (!s) return 0;
  return new Date(s).getTime() * 1_000_000;
}

function formatNs(ns: number): string {
  if (!ns) return '—';
  return new Date(ns / 1_000_000).toLocaleString();
}

export default function HistoryConfigDialog({ open, onClose, hp }: HistoryConfigDialogProps) {
  const { bounds, range, setRange, filters, setFilters, isLoading, loadTraces } = hp;

  const handleFromChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRange({ ...range, from: datetimeLocalToNs(e.target.value) });
  }, [range, setRange]);

  const handleToChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRange({ ...range, to: datetimeLocalToNs(e.target.value) });
  }, [range, setRange]);

  const applyPreset = useCallback((preset: 'last1h' | 'last24h' | 'last7d' | 'all') => {
    const nowNs = Date.now() * 1_000_000;
    let from = 0;
    let to   = nowNs;
    switch (preset) {
      case 'last1h':  from = nowNs - 1 * 3_600 * 1_000_000_000; break;
      case 'last24h': from = nowNs - 24 * 3_600 * 1_000_000_000; break;
      case 'last7d':  from = nowNs - 7 * 86_400 * 1_000_000_000; break;
      case 'all':
        from = bounds?.min_started_at ?? 0;
        to   = bounds?.max_started_at ?? nowNs;
        break;
    }
    setRange({ from, to });
  }, [bounds, setRange]);

  const handleFilterChange = useCallback(
    (key: keyof HistoryFilters) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setFilters({ ...filters, [key]: e.target.value });
    },
    [filters, setFilters],
  );

  const handleLoad = useCallback(async () => {
    await loadTraces();
    onClose();
  }, [loadTraces, onClose]);

  if (!open) return null;

  const canLoad = !isLoading && !!(range.from || range.to);

  return createPortal(
    <div id="hist-dialog-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div id="hist-dialog" role="dialog" aria-modal="true" aria-label="History Configuration">

        {/* Header */}
        <div id="hist-dialog-header">
          <div>
            <div id="hist-dialog-title">History Configuration</div>
            <div id="hist-dialog-subtitle">Set time range and filters, then load traces</div>
          </div>
          <button id="hist-dialog-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div id="hist-dialog-body">

          {/* Range section */}
          <div className="hist-section">
            <div className="hist-section-label">Time Range</div>
            <div className="hist-range-row">
              <div className="hist-field">
                <label className="hist-field-label">From</label>
                <input
                  type="datetime-local"
                  className="hist-datetime"
                  value={nsToDatetimeLocal(range.from)}
                  onChange={handleFromChange}
                />
              </div>
              <div className="hist-field">
                <label className="hist-field-label">To</label>
                <input
                  type="datetime-local"
                  className="hist-datetime"
                  value={nsToDatetimeLocal(range.to)}
                  onChange={handleToChange}
                />
              </div>
            </div>
            <div className="hist-presets">
              <span className="hist-presets-label">Presets:</span>
              {(['last1h', 'last24h', 'last7d', 'all'] as const).map(p => (
                <button key={p} className="hist-preset-btn" onClick={() => applyPreset(p)}>
                  {p === 'last1h'  ? 'Last 1h'  :
                   p === 'last24h' ? 'Last 24h' :
                   p === 'last7d'  ? 'Last 7d'  : 'All'}
                </button>
              ))}
            </div>
            {bounds && (
              <div className="hist-db-hint">
                DB: {formatNs(bounds.min_started_at)} → {formatNs(bounds.max_started_at)}
                {' '}({bounds.count.toLocaleString()} traces)
              </div>
            )}
          </div>

          {/* Filters section */}
          <div className="hist-section">
            <div className="hist-section-label">Filters</div>
            <div className="hist-filters-grid">
              <div className="hist-field hist-field-wide">
                <label className="hist-field-label">Service / target</label>
                <input
                  type="text"
                  className="hist-input"
                  placeholder="substring match, e.g. my-service"
                  value={filters.service}
                  onChange={handleFilterChange('service')}
                />
              </div>
              <div className="hist-field">
                <label className="hist-field-label">Min duration (ms)</label>
                <input
                  type="number"
                  className="hist-input"
                  min={0}
                  placeholder="e.g. 100"
                  value={filters.minDurationMs}
                  onChange={handleFilterChange('minDurationMs')}
                />
              </div>
              <div className="hist-field">
                <label className="hist-field-label">Max duration (ms)</label>
                <input
                  type="number"
                  className="hist-input"
                  min={0}
                  placeholder="e.g. 5000"
                  value={filters.maxDurationMs}
                  onChange={handleFilterChange('maxDurationMs')}
                />
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div id="hist-dialog-footer">
          <button id="hist-dialog-cancel" onClick={onClose}>Cancel</button>
          <button
            id="hist-dialog-load"
            onClick={handleLoad}
            disabled={!canLoad}
          >
            {isLoading ? 'Loading…' : 'Load Traces'}
          </button>
        </div>

      </div>
    </div>,
    document.body,
  );
}
