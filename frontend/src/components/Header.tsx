// ── Header: top navigation bar ───────────────────────────────────────────────

import React from 'react';
import type { TabId } from '../App.tsx';

interface HeaderProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  wsConnected: boolean;
  demoMode: boolean;
  onExitDemo: () => void;
  sps: number;
  tps: number;
  spansFlashing: boolean;
  onOpenFilters: () => void;
}

export default function Header({
  activeTab,
  onTabChange,
  wsConnected,
  demoMode,
  onExitDemo,
  sps,
  tps,
  spansFlashing,
  onOpenFilters,
}: HeaderProps) {
  const statusColor = demoMode ? '#64c8ff' : wsConnected ? 'var(--c-ok)' : 'var(--c-error)';
  const statusLabel = demoMode ? 'demo' : wsConnected ? 'live' : 'reconnecting\u2026';
  const statusShadow = `0 0 8px ${statusColor}`;

  return (
    <header id="header">
      <div className="logo">
        <div className="logo-mark">O</div>
        <div>
          <div className="logo-text">OTel UI</div>
        </div>
      </div>
      <div className="logo-sub">Live Trace Diagram</div>
      <div className="header-spacer" />

      <div id="header-metrics">
        <div
          id="span-flash"
          className={spansFlashing ? 'flash' : undefined}
        />
        <div className="hdr-metric">
          <span className="hdr-metric-value" id="hdr-sps">{sps}</span>
          <span className="hdr-metric-label">spans/s</span>
        </div>
        <div className="hdr-metric">
          <span className="hdr-metric-value" id="hdr-tps">{tps}</span>
          <span className="hdr-metric-label">traces/s</span>
        </div>
      </div>

      <div
        className="status-dot"
        style={{ background: statusColor, boxShadow: statusShadow }}
      />
      <span className="status-label">{statusLabel}</span>

      {demoMode && (
        <div id="demo-banner">
          ▶ Demo mode —{' '}
          <button onClick={onExitDemo}>Exit</button>
        </div>
      )}

      <button id="hide-rules-btn" title="Manage hidden spans" onClick={onOpenFilters}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M1 6 C2.5 2.5 9.5 2.5 11 6 C9.5 9.5 2.5 9.5 1 6Z" />
          <line x1="2" y1="2" x2="10" y2="10" />
        </svg>
        Filters
      </button>

      <div id="tab-bar">
        <button
          className={`tab-btn${activeTab === 'diagram' ? ' tab-active' : ''}`}
          onClick={() => onTabChange('diagram')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="3" cy="6" r="2" /><circle cx="9" cy="3" r="2" /><circle cx="9" cy="9" r="2" />
            <line x1="5" y1="6" x2="7" y2="3.5" /><line x1="5" y1="6" x2="7" y2="8.5" />
          </svg>
          Diagram
        </button>
        <button
          className={`tab-btn${activeTab === 'spans' ? ' tab-active' : ''}`}
          onClick={() => onTabChange('spans')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="2" width="10" height="1.5" rx="0.5" /><rect x="1" y="5" width="10" height="1.5" rx="0.5" />
            <rect x="1" y="8" width="7" height="1.5" rx="0.5" />
          </svg>
          Spans
        </button>
        <button
          className={`tab-btn${activeTab === 'traces' ? ' tab-active' : ''}`}
          onClick={() => onTabChange('traces')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="3" width="4" height="2" rx="0.5" />
            <rect x="7" y="1" width="4" height="2" rx="0.5" />
            <rect x="7" y="5" width="4" height="2" rx="0.5" />
            <rect x="7" y="9" width="4" height="2" rx="0.5" />
            <line x1="5" y1="4" x2="7" y2="2" />
            <line x1="5" y1="4" x2="7" y2="6" />
            <line x1="5" y1="4" x2="7" y2="10" />
          </svg>
          Traces
        </button>
        <button
          className={`tab-btn${activeTab === 'statistics' ? ' tab-active' : ''}`}
          onClick={() => onTabChange('statistics')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="7" width="2.5" height="4" rx="0.5" />
            <rect x="4.75" y="4" width="2.5" height="7" rx="0.5" />
            <rect x="8.5" y="1" width="2.5" height="10" rx="0.5" />
          </svg>
          Stats
        </button>
      </div>
    </header>
  );
}
