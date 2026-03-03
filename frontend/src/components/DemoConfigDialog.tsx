// ── DemoConfigDialog: live-control of demo emission parameters ────────────────

import React, { useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { DemoConfig } from '../core/demo.ts';
import type { DemoConfig, DemoScenario } from '../core/demo.ts';

interface DemoConfigDialogProps {
  open:     boolean;
  onClose:  () => void;
  config:   DemoConfig;
  onChange: (c: DemoConfig) => void;
  scenario: DemoScenario;
}

function DemoSlider({
  label, sub, value, min, max, step, format, onChange,
}: {
  label: string; sub?: string; value: number; min: number; max: number;
  step: number; format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div className="dcfg-row">
      <div className="dcfg-row-head">
        <span className="dcfg-label">{label}</span>
        {sub && <span className="dcfg-sub">{sub}</span>}
        <span className="dcfg-val">{format(value)}</span>
      </div>
      <input
        type="range"
        className="dcfg-slider"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
      <div className="dcfg-range-labels">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
}

export default function DemoConfigDialog({ open, onClose, config, onChange, scenario }: DemoConfigDialogProps) {
  const set = useCallback((key: keyof DemoConfig) => (v: number) => {
    onChange({ ...config, [key]: v });
  }, [config, onChange]);

  if (!open) return null;

  return createPortal(
    <div id="dcfg-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div id="dcfg-dialog" role="dialog" aria-modal="true" aria-label="Demo Settings">

        <div id="dcfg-header">
          <div>
            <div id="dcfg-title">Demo Settings</div>
            <div id="dcfg-subtitle">Changes apply instantly — no restart needed</div>
          </div>
          <button id="dcfg-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div id="dcfg-body">
          <DemoSlider
            label="Traces / second"
            value={config.tracesPerSec}
            min={0.5} max={10} step={0.5}
            format={v => `${v.toFixed(1)} /s`}
            onChange={set('tracesPerSec')}
          />
          <DemoSlider
            label="Max tree depth"
            sub="span nesting levels (topology)"
            value={config.maxDepth}
            min={1} max={6} step={1}
            format={v => String(v)}
            onChange={set('maxDepth')}
          />
          <DemoSlider
            label="Max children per span"
            value={config.maxFanout}
            min={1} max={5} step={1}
            format={v => String(v)}
            onChange={set('maxFanout')}
          />
          <DemoSlider
            label="Error rate"
            value={config.errorRate}
            min={0} max={0.5} step={0.01}
            format={v => `${Math.round(v * 100)}%`}
            onChange={set('errorRate')}
          />
          <DemoSlider
            label="Outlier rate"
            sub="slow traces (150ms – 1.5s)"
            value={config.outlierRate}
            min={0} max={0.5} step={0.01}
            format={v => `${Math.round(v * 100)}%`}
            onChange={set('outlierRate')}
          />
        </div>

        <div id="dcfg-footer">
          <button id="dcfg-reset" onClick={() => onChange({ ...DEFAULT_DEMO_CONFIG })}>
            Reset defaults
          </button>
          <button id="dcfg-close-btn" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>,
    document.body,
  );
}
