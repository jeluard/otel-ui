// ── WelcomeScreen: shown before any data arrives ──────────────────────────────

import React, { useState } from 'react';
import type { HistoryPlayback } from '../hooks/useHistoryPlayback.ts';
import type { DemoScenario } from '../core/demo.ts';

declare const __BRIDGE_IMAGE__: string;

interface WelcomeScreenProps {
  wsConnected: boolean;
  welcomeVisible: boolean;
  onConnectLive: () => void;
  onEnterDemo: (scenario: DemoScenario) => void;
  historyPlayback?: HistoryPlayback;
  hasReceivedTraces?: boolean;
}

export default function WelcomeScreen({ wsConnected, welcomeVisible, onConnectLive, onEnterDemo, historyPlayback, hasReceivedTraces }: WelcomeScreenProps) {
  const [scenario, setScenario] = useState<DemoScenario>('standard');

  if (!welcomeVisible || historyPlayback?.historyEnabled) return null;

  const hasHistoryData = historyPlayback && historyPlayback.bounds && historyPlayback.bounds.count > 0;
  const statusColor = wsConnected ? 'var(--c-ok)' : 'var(--c-error)';
  const statusLabel = wsConnected ? 'live' : 'connecting\u2026';

  return (
    <div id="welcome-screen">
      <div id="welcome-inner">
        <div className="logo" style={{ justifyContent: 'center', marginBottom: 8 }}>
          <div className="logo-mark">O</div>
          <div>
            <div className="logo-text">OTel UI</div>
            <div className="logo-sub">Live Trace Diagram</div>
          </div>
        </div>

        <p className="welcome-desc">
          A real-time diagram that visualises OpenTelemetry spans as animated particles
          flowing between component nodes.
        </p>

        <div className="welcome-section">
          <div className="welcome-section-title">Connect your process</div>
          {wsConnected ? (
            <div id="ws-bridge-ok">
              <div className="ws-bridge-ok-badge">✓ Bridge connected</div>
              <button id="live-connect-btn" onClick={onConnectLive} disabled={!hasReceivedTraces}>▶ Start live view</button>
            </div>
          ) : (
            <div id="ws-step1">
              <div className="welcome-step"><b>1.</b> Run the bridge on your machine</div>
              <div className="hint-code" id="bridge-docker-cmd">
                {`docker run --rm -p 4317:4317 -p 8080:8080 ${__BRIDGE_IMAGE__}`}
              </div>
            </div>
          )}
          <div className="welcome-step" style={{ marginTop: 4 }}>
            <b>{wsConnected ? '▶' : '2.'}</b> Point your service at the bridge
          </div>
          <div className="hint-code">OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317</div>
          <div className="welcome-step" style={{ marginTop: 8, color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
            gRPC :4317 · HTTP :4318 · WS ws://localhost:8080
          </div>
          {hasHistoryData && (
            <>
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', margin: '12px 0' }} />
              <div className="welcome-step" style={{ marginTop: 8 }}>
                Or browse previously recorded traces:
              </div>
              <button id="history-mode-btn" onClick={() => historyPlayback?.toggleHistory()}>
                ▶ Browse History ({historyPlayback?.bounds?.count} traces)
              </button>
            </>
          )}
        </div>

        <div className="welcome-divider">or</div>

        <div className="welcome-section">
          <div className="welcome-section-title">Explore with demo data</div>
          <div className="welcome-step">See how the UI looks with representative generated traces.</div>

          <div className="demo-scenario-options">
            <label className="demo-scenario-option">
              <input
                type="radio"
                name="demo-scenario"
                value="standard"
                checked={scenario === 'standard'}
                onChange={() => setScenario('standard')}
              />
              <span className="demo-scenario-label">
                <span className="demo-scenario-name">Standard</span>
                <span className="demo-scenario-desc">Distributed service topology with random traces</span>
              </span>
            </label>
            <label className="demo-scenario-option">
              <input
                type="radio"
                name="demo-scenario"
                value="multi-instance"
                checked={scenario === 'multi-instance'}
                onChange={() => setScenario('multi-instance')}
              />
              <span className="demo-scenario-label">
                <span className="demo-scenario-name">Multi-instance</span>
                <span className="demo-scenario-desc">Parallel workers with correlated traces per block</span>
              </span>
            </label>
          </div>

          <button id="demo-mode-btn" onClick={() => onEnterDemo(scenario)}>▶ Enter Demo Mode</button>
        </div>

        <div id="welcome-status">
          <div
            className="status-dot"
            style={{ background: statusColor, boxShadow: `0 0 8px ${statusColor}` }}
          />
          <span className="status-label">{statusLabel}</span>
        </div>
      </div>
    </div>
  );
}
