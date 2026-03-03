// ── Header: top navigation bar ───────────────────────────────────────────────

import React, { useState, useEffect, useRef } from 'react';
import type { TabId } from '../App.tsx';
import type { HistoryPlayback } from '../hooks/useHistoryPlayback.ts';
import HistoryControls     from './HistoryControls.tsx';
import HistoryConfigDialog from './HistoryConfigDialog.tsx';
import DemoConfigDialog    from './DemoConfigDialog.tsx';
import type { DemoConfig, DemoScenario } from '../core/demo.ts';

interface HeaderProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  wsConnected: boolean;
  demoMode: boolean;
  demoScenario: DemoScenario;
  onExitDemo: () => void;
  demoConfig: DemoConfig;
  onDemoConfigChange: (c: DemoConfig) => void;
  onLogoClick: () => void;
  sps: number;
  tps: number;
  spansFlashing: boolean;
  onOpenFilters: () => void;
  onOpenCorrelationKeySettings: () => void;
  historyPlayback: HistoryPlayback;
}

export default function Header({
  activeTab,
  onTabChange,
  wsConnected,
  demoMode,
  demoScenario,
  onExitDemo,
  demoConfig,
  onDemoConfigChange,
  onLogoClick,
  sps,
  tps,
  spansFlashing,
  onOpenFilters,
  onOpenCorrelationKeySettings,
  historyPlayback,
}: HeaderProps) {
  const { historyEnabled, toggleHistory } = historyPlayback;
  const [showHistoryConfig, setShowHistoryConfig] = useState(false);
  const [showDemoConfig,    setShowDemoConfig]    = useState(false);
  const historyEnabledRef = useRef(historyEnabled);

  // Auto-open config dialog when entering history mode
  useEffect(() => {
    if (historyEnabled && !historyEnabledRef.current) {
      setShowHistoryConfig(true);
    }
    historyEnabledRef.current = historyEnabled;
  }, [historyEnabled]);

  const statusColor = demoMode ? '#64c8ff' : historyEnabled ? 'var(--c-amber)' : wsConnected ? 'var(--c-ok)' : 'var(--c-error)';
  const statusLabel = demoMode ? 'demo' : historyEnabled ? 'history' : wsConnected ? 'live' : 'reconnecting\u2026';
  const statusShadow = `0 0 8px ${statusColor}`;

  return (
    <header id="header">
      <button className="logo logo-btn" onClick={onLogoClick} title="Back to home">
        <div className="logo-mark">O</div>
        <div>
          <div className="logo-text">OTel UI</div>
        </div>
      </button>
      <div className="logo-sub">
        {historyEnabled ? 'History Mode' : 'Live Trace Diagram'}
      </div>
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
          ▶ Demo{' '}
          <button onClick={() => setShowDemoConfig(true)} title="Demo settings">⚙ Settings</button>
          <button onClick={onExitDemo}>Exit</button>
        </div>
      )}

      <label id="history-toggle" title="Browse historical traces from the database">
        <input
          type="checkbox"
          checked={historyEnabled}
          onChange={toggleHistory}
        />
        History
      </label>

      <button id="hide-rules-btn" title="Manage hidden spans" onClick={onOpenFilters}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M1 6 C2.5 2.5 9.5 2.5 11 6 C9.5 9.5 2.5 9.5 1 6Z" />
          <line x1="2" y1="2" x2="10" y2="10" />
        </svg>
        Filters
      </button>

      <button id="correlation-key-btn" title="Configure correlation key preference" onClick={onOpenCorrelationKeySettings}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="3" cy="6" r="1" /><circle cx="9" cy="6" r="1" />
          <line x1="4" y1="6" x2="8" y2="6" />
          <path d="M3 3 Q3 2 4 2 L8 2 Q9 2 9 3" />
        </svg>
        Correlation
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
      {historyEnabled && <HistoryControls hp={historyPlayback} onOpenConfig={() => setShowHistoryConfig(true)} />}
      {historyEnabled && (
        <HistoryConfigDialog
          open={showHistoryConfig}
          onClose={() => setShowHistoryConfig(false)}
          hp={historyPlayback}
        />
      )}
      {demoMode && (
        <DemoConfigDialog
          open={showDemoConfig}
          onClose={() => setShowDemoConfig(false)}
          config={demoConfig}
          onChange={onDemoConfigChange}
          scenario={demoScenario}
        />
      )}
    </header>
  );
}
