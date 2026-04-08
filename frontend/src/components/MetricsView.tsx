// ── MetricsView: real-time metrics dashboard powered by uPlot ─────────────────

import React, {
  useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useMemo,
} from 'react';
import uPlot from 'uplot';
import type { MetricEvent } from '../core/types.ts';

// ── Persistence helpers ────────────────────────────────────────────────────────

const DASH_VERSION = 1;

interface SavedPanel {
  id:         string;
  title:      string;
  seriesKeys: string[];
}

interface DashboardSave {
  version:     number;
  fingerprint: string;  // sorted joined service names
  windowSec:   number;
  panels:      SavedPanel[];
}

function storageKey(fingerprint: string): string {
  return `otel-ui:dash:${fingerprint}`;
}

function saveDashboard(fingerprint: string, windowSec: number, panels: Panel[]): void {
  try {
    const data: DashboardSave = {
      version: DASH_VERSION,
      fingerprint,
      windowSec,
      panels: panels.map(p => ({ id: p.id, title: p.title, seriesKeys: p.seriesKeys })),
    };
    localStorage.setItem(storageKey(fingerprint), JSON.stringify(data));
  } catch (_) { /* quota exceeded — ignore */ }
}

function loadDashboard(fingerprint: string): DashboardSave | null {
  try {
    const raw = localStorage.getItem(storageKey(fingerprint));
    if (!raw) return null;
    const data = JSON.parse(raw) as DashboardSave;
    if (data.version !== DASH_VERSION || data.fingerprint !== fingerprint) return null;
    return data;
  } catch (_) { return null; }
}

// ── Public handle ─────────────────────────────────────────────────────────────

export interface MetricsViewHandle {
  onMetricsBatch(metrics: MetricEvent[]): void;
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface SeriesMeta {
  key:         string;
  service:     string;
  metric:      string;
  unit:        string;
  description: string;
  attrs:       [string, string][];
}

interface Panel {
  id:         string;
  title:      string;
  seriesKeys: string[];
}

interface Buffer {
  times: number[]; // unix seconds
  vals:  number[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_BUFFER = 3600; // 1 h at 1 sample/s

const WINDOW_OPTIONS: { label: string; value: number }[] = [
  { label: '30 s',  value: 30   },
  { label: '1 min', value: 60   },
  { label: '5 min', value: 300  },
  { label: '15 min', value: 900  },
  { label: '30 min', value: 1800 },
  { label: '1 h',   value: 3600 },
];
const DEFAULT_WINDOW_SEC = 300;

const SERIES_COLORS = [
  '#22d3ee', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899',
  '#14b8a6', '#f43f5e', '#6366f1', '#0ea5e9', '#a855f7', '#84cc16', '#f97316',
];

let _seq = 0;
const mkId = () => `panel-${++_seq}`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function seriesKey(e: MetricEvent): string {
  const fp = [...e.attributes]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${e.service_name}\0${e.metric_name}\0${fp}`;
}

function extractValue(e: MetricEvent): number | null {
  switch (e.value.kind) {
    case 'gauge':     return e.value.value;
    case 'sum':       return e.value.value;
    case 'histogram': return e.value.count;
  }
}

function attrSummary(attrs: [string, string][]): string {
  return attrs.map(([, v]) => v).join(', ');
}

function buildData(
  seriesKeys: string[],
  buffers: Map<string, Buffer>,
  windowSec: number,
): uPlot.AlignedData {
  const now    = Date.now() / 1000;
  const cutoff = now - windowSec;

  const tsSet = new Set<number>();
  tsSet.add(cutoff); // anchor left edge
  tsSet.add(now);    // anchor right edge
  for (const k of seriesKeys) {
    const b = buffers.get(k);
    if (b) for (const t of b.times) { if (t >= cutoff) tsSet.add(t); }
  }
  const times = [...tsSet].sort((a, b) => a - b);

  const ys = seriesKeys.map(k => {
    const b = buffers.get(k);
    if (!b || !b.times.length) return times.map(() => null as number | null);
    const m = new Map<number, number | null>();
    for (let i = 0; i < b.times.length; i++) m.set(b.times[i], b.vals[i] ?? null);
    return times.map(t => m.has(t) ? m.get(t)! : null as number | null);
  });

  return [times, ...ys] as unknown as uPlot.AlignedData;
}

function makeUPlotOpts(
  width: number,
  seriesKeys: string[],
  catalog: Map<string, SeriesMeta>,
): uPlot.Options {
  return {
    width,
    height: 220,
    series: [
      {},
      ...seriesKeys.map((k, i) => {
        const m  = catalog.get(k);
        const lbl = m
          ? `${m.service} · ${m.metric}${m.attrs.length ? ' (' + attrSummary(m.attrs) + ')' : ''}`
          : k.split('\0').slice(0, 2).join(' ');
        return {
          label:    lbl,
          stroke:   SERIES_COLORS[i % SERIES_COLORS.length],
          width:    1.5,
          spanGaps: true,
        };
      }),
    ],
    axes: [
      {
        stroke: '#475569',
        grid:  { stroke: 'rgba(255,255,255,0.05)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.05)', width: 1 },
        space: 60,
        values: (_u: uPlot, splits: number[]) =>
          splits.map((s: number) =>
            new Date(s * 1000).toLocaleTimeString('en-GB', {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
            }),
          ),
        size: 36,
      },
      {
        stroke: '#475569',
        grid:  { stroke: 'rgba(255,255,255,0.05)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.05)', width: 1 },
        size:  56,
      },
    ],
    cursor: { show: true },
    legend: { show: false }, // we render our own colour legend
    padding: [12, 8, 16, 0],
  };
}

// ── ChartPanel ─────────────────────────────────────────────────────────────────

interface ChartPanelProps {
  panel:          Panel;
  catalog:        Map<string, SeriesMeta>;
  buffersRef:     React.MutableRefObject<Map<string, Buffer>>;
  plotsRef:       React.MutableRefObject<Map<string, uPlot>>;
  windowSecRef:   React.MutableRefObject<number>;
  onRemovePanel:  (id: string) => void;
  onRemoveSeries: (panelId: string, key: string) => void;
}

const ChartPanel = React.memo(function ChartPanel({
  panel, catalog, buffersRef, plotsRef, windowSecRef, onRemovePanel, onRemoveSeries,
}: ChartPanelProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    plotsRef.current.get(panel.id)?.destroy();
    plotsRef.current.delete(panel.id);
    if (!panel.seriesKeys.length) return;

    // Use RAF so grid layout is settled before we read width
    const rafId = requestAnimationFrame(() => {
      const w   = el.clientWidth || 500;
      const win = windowSecRef.current;
      const now = Date.now() / 1000;
      const opts = makeUPlotOpts(w, panel.seriesKeys, catalog);
      const data = buildData(panel.seriesKeys, buffersRef.current, win);
      const u    = new uPlot(opts, data, el);
      u.setScale('x', { min: now - win, max: now });
      plotsRef.current.set(panel.id, u);

      const ro = new ResizeObserver(() => {
        const newW = el.clientWidth;
        if (newW > 0) u.setSize({ width: newW, height: 220 });
      });
      ro.observe(el.parentElement ?? el);

      // store cleanup on the ref so the outer cleanup can call it
      (el as HTMLDivElement & { _roCleanup?: () => void })._roCleanup = () => {
        ro.disconnect();
        u.destroy();
        plotsRef.current.delete(panel.id);
      };
    });

    return () => {
      cancelAnimationFrame(rafId);
      const cleanup = (el as HTMLDivElement & { _roCleanup?: () => void })._roCleanup;
      if (cleanup) { cleanup(); delete (el as HTMLDivElement & { _roCleanup?: () => void })._roCleanup; }
    };
  // Recreate uPlot instance only when the series fingerprint changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id, panel.seriesKeys.join('\0')]);

  return (
    <div className="mc-panel">
      <div className="mc-panel-hdr">
        <span className="mc-panel-title">{panel.title}</span>
        <button
          className="mc-icon-btn"
          onClick={() => onRemovePanel(panel.id)}
          title="Remove panel"
        >✕</button>
      </div>

      {/* Custom legend */}
      <div className="mc-legend">
        {panel.seriesKeys.map((k, i) => {
          const m = catalog.get(k);
          const lbl = m
            ? `${m.service} · ${m.metric}${m.attrs.length ? ' (' + attrSummary(m.attrs) + ')' : ''} ${m.unit ? '[' + m.unit + ']' : ''}`
            : k.split('\0').slice(0, 2).join(' ');
          return (
            <span key={k} className="mc-legend-item">
              <span
                className="mc-legend-dot"
                style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
              />
              <span className="mc-legend-lbl">{lbl}</span>
              <button
                className="mc-icon-btn mc-legend-rm"
                onClick={() => onRemoveSeries(panel.id, k)}
                title="Remove series"
              >✕</button>
            </span>
          );
        })}
      </div>

      {/* uPlot mounts here */}
      <div ref={wrapRef} className="mc-chart-wrap" />
    </div>
  );
});

// ── MetricsView ────────────────────────────────────────────────────────────────

const MetricsView = forwardRef<MetricsViewHandle>(function MetricsView(_props, ref) {
  const buffersRef    = useRef<Map<string, Buffer>>(new Map());
  const plotsRef      = useRef<Map<string, uPlot>>(new Map());
  const catalogRef    = useRef<Map<string, SeriesMeta>>(new Map());
  const panelsRef     = useRef<Panel[]>([]);
  const windowSecRef  = useRef<number>(DEFAULT_WINDOW_SEC);

  const [catalog,    setCatalog]    = useState<Map<string, SeriesMeta>>(new Map());
  const [panels,     setPanels]     = useState<Panel[]>([]);
  const [windowSec,  setWindowSec]  = useState<number>(DEFAULT_WINDOW_SEC);

  // ── Persistence state ────────────────────────────────────────────────────
  const fingerprintRef  = useRef<string>('');
  const loadedRef       = useRef<boolean>(false); // have we applied a saved dashboard?
  const importInputRef  = useRef<HTMLInputElement>(null);
  const [importBanner, setImportBanner] = useState<string | null>(null);

  // Keep windowSecRef in sync
  useEffect(() => { windowSecRef.current = windowSec; }, [windowSec]);

  // Auto-save whenever panels or windowSec change (once we have a fingerprint)
  useEffect(() => {
    if (!fingerprintRef.current) return;
    saveDashboard(fingerprintRef.current, windowSec, panels);
  }, [panels, windowSec]);
  // { key: seriesKey, anchorEl rect } — which catalog entry has the popover open
  const [popover, setPopover]  = useState<{ key: string; top: number; left: number } | null>(null);

  // Keep mutable refs in sync so imperative handle can read without stale closures
  useEffect(() => { catalogRef.current = catalog; }, [catalog]);
  useEffect(() => { panelsRef.current  = panels;  }, [panels]);

  // ── Clock tick: advance all charts with a null point so the x-axis scrolls
  //    even when no metrics arrive, making gaps visible as blank areas.
  useEffect(() => {
    const id = setInterval(() => {
      if (panelsRef.current.length === 0) return;
      const now = Date.now() / 1000;
      for (const panel of panelsRef.current) {
        const u = plotsRef.current.get(panel.id);
        if (!u) continue;
        // Append a null sentinel per series so uPlot extends the time axis
        // without drawing a line (gap = no data).
        const win = windowSecRef.current;
        for (const k of panel.seriesKeys) {
          const buf = buffersRef.current.get(k);
          if (!buf) continue;
          // Only push if the last point is stale (>2 s old) to avoid doubling real data
          const last = buf.times[buf.times.length - 1] ?? 0;
          if (now - last > 1.5) {
            buf.times.push(now);
            buf.vals.push(null as unknown as number);
            if (buf.times.length > MAX_BUFFER) { buf.times.shift(); buf.vals.shift(); }
          }
          // Trim old data outside window
          const cutoff = now - win;
          while (buf.times.length > 0 && buf.times[0] < cutoff) { buf.times.shift(); buf.vals.shift(); }
        }
        try {
          u.setData(buildData(panel.seriesKeys, buffersRef.current, win), false);
          u.setScale('x', { min: now - win, max: now });
        }
        catch (_) { /* ignore race */ }
      }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // ── Imperative handle ──────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    onMetricsBatch(metrics: MetricEvent[]) {
      const updatedKeys = new Set<string>();

      for (const e of metrics) {
        const v = extractValue(e);
        if (v === null) continue;

        const key = seriesKey(e);
        const ts  = e.timestamp_unix_nano > 0 ? e.timestamp_unix_nano / 1e9 : Date.now() / 1000;

        // Update rolling buffer
        let buf = buffersRef.current.get(key);
        if (!buf) {
          buf = { times: [], vals: [] };
          buffersRef.current.set(key, buf);
        }
        if (!buf.times.length || ts >= buf.times[buf.times.length - 1]) {
          buf.times.push(ts);
          buf.vals.push(v);
          if (buf.times.length > MAX_BUFFER) { buf.times.shift(); buf.vals.shift(); }
        }
        updatedKeys.add(key);

        // Register in catalog if unseen
        if (!catalogRef.current.has(key)) {
          const meta: SeriesMeta = {
            key,
            service:     e.service_name,
            metric:      e.metric_name,
            unit:        e.unit,
            description: e.description,
            attrs:       e.attributes,
          };
          catalogRef.current.set(key, meta);
          setCatalog(new Map(catalogRef.current));

          // Update fingerprint (sorted unique service names)
          const services = [...new Set([...catalogRef.current.values()].map(m => m.service))].sort();
          const fp = services.join(',');
          if (fp !== fingerprintRef.current) {
            fingerprintRef.current = fp;
            // First time we get a fingerprint — try to restore saved dashboard
            if (!loadedRef.current) {
              loadedRef.current = true;
              const saved = loadDashboard(fp);
              if (saved) {
                setWindowSec(saved.windowSec);
                windowSecRef.current = saved.windowSec;
                const restored: Panel[] = saved.panels.map(sp => ({
                  id:         sp.id,
                  title:      sp.title,
                  seriesKeys: sp.seriesKeys,
                }));
                setPanels(restored);
              }
            }
          }
        }
      }

      // Push data to active plots — no React re-render needed
      for (const panel of panelsRef.current) {
        if (!panel.seriesKeys.some(k => updatedKeys.has(k))) continue;
        const u = plotsRef.current.get(panel.id);
        if (u) {
          const win = windowSecRef.current;
          const now = Date.now() / 1000;
          try {
            u.setData(buildData(panel.seriesKeys, buffersRef.current, win), false);
            u.setScale('x', { min: now - win, max: now });
          }
          catch (_) { /* ignore race during destroy */ }
        }
      }
    },
  }), []);

  // ── Panel mutation helpers ─────────────────────────────────────────────────

  const addSeriesToPanel = useCallback((panelId: string | 'new', key: string) => {
    setPopover(null);
    const meta = catalogRef.current.get(key);
    if (!meta) return;
    if (panelId === 'new') {
      const panel: Panel = {
        id:         mkId(),
        title:      meta.metric,
        seriesKeys: [key],
      };
      setPanels(prev => [...prev, panel]);
    } else {
      setPanels(prev => prev.map(p =>
        p.id === panelId && !p.seriesKeys.includes(key)
          ? { ...p, seriesKeys: [...p.seriesKeys, key] }
          : p,
      ));
    }
  }, []);

  const removePanel = useCallback((id: string) => {
    setPanels(prev => prev.filter(p => p.id !== id));
  }, []);

  const removeSeries = useCallback((panelId: string, key: string) => {
    setPanels(prev => prev.map(p =>
      p.id === panelId
        ? { ...p, seriesKeys: p.seriesKeys.filter(k => k !== key) }
        : p,
    ).filter(p => p.seriesKeys.length > 0));
  }, []);

  // ── Import / Export ─────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const fp = fingerprintRef.current || 'unknown';
    const data: DashboardSave = {
      version:     DASH_VERSION,
      fingerprint: fp,
      windowSec:   windowSecRef.current,
      panels:      panelsRef.current.map(p => ({ id: p.id, title: p.title, seriesKeys: p.seriesKeys })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `otel-ui-metrics-${fp.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as DashboardSave;
        if (data.version !== DASH_VERSION || !Array.isArray(data.panels)) {
          setImportBanner('Invalid dashboard file.');
          return;
        }
        setWindowSec(data.windowSec);
        windowSecRef.current = data.windowSec;
        const imported: Panel[] = data.panels.map(sp => ({
          id:         mkId(), // fresh id to avoid collisions
          title:      sp.title,
          seriesKeys: sp.seriesKeys,
        }));
        setPanels(imported);
        setImportBanner(`Imported ${imported.length} panel${imported.length !== 1 ? 's' : ''} from "${file.name}"`);
        setTimeout(() => setImportBanner(null), 4000);
      } catch (_) {
        setImportBanner('Failed to parse dashboard file.');
        setTimeout(() => setImportBanner(null), 4000);
      }
    };
    reader.readAsText(file);
  }, []);

  // ── Sidebar: catalog grouped by metric name ────────────────────────────────

  const grouped = useMemo(() => {
    const groups = new Map<string, SeriesMeta[]>();
    for (const m of catalog.values()) {
      const arr = groups.get(m.metric) ?? [];
      arr.push(m);
      groups.set(m.metric, arr);
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [catalog]);

  const openPopover = useCallback((e: React.MouseEvent, key: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopover({ key, top: rect.bottom + 4, left: rect.left });
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!popover) return;
    const handler = () => setPopover(null);
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [popover]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div id="metrics-view">
      {/* Left: catalog */}
      <aside className="mc-sidebar">
        <div className="mc-sidebar-hdr">Available metrics</div>

        {grouped.length === 0 && (
          <div className="mc-sidebar-empty">
            No metrics received yet.<br />
            Send OTLP metrics to the collector<br />
            and they will appear here.
          </div>
        )}

        {grouped.map(([metricName, entries]) => (
          <div key={metricName} className="mc-metric-group">
            <div className="mc-metric-name">{metricName}</div>
            {entries.map(m => (
              <div key={m.key} className="mc-series-row">
                <div className="mc-series-info">
                  <span className="mc-series-svc">{m.service}</span>
                  {m.attrs.length > 0 && (
                    <span className="mc-series-attrs">{attrSummary(m.attrs)}</span>
                  )}
                  {m.unit && <span className="mc-series-unit">[{m.unit}]</span>}
                </div>
                <button
                  className="mc-add-btn"
                  title="Add to dashboard"
                  onClick={e => { e.stopPropagation(); openPopover(e, m.key); }}
                >+ Add</button>
              </div>
            ))}
          </div>
        ))}
      </aside>

      {/* Right: dashboard */}
      <div className="mc-dashboard">
        <div className="mc-dash-toolbar">
          <label className="mc-window-label" htmlFor="mc-window-select">Window</label>
          <select
            id="mc-window-select"
            className="mc-window-select"
            value={windowSec}
            onChange={e => setWindowSec(Number(e.target.value))}
          >
            {WINDOW_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div className="mc-dash-spacer" />
          {fingerprintRef.current && (
            <span className="mc-fingerprint" title="Identified by service names">
              {fingerprintRef.current.split(',').join(' · ')}
            </span>
          )}
          <button className="mc-action-btn" title="Export dashboard" onClick={handleExport}>
            ↓ Export
          </button>
          <button className="mc-action-btn" title="Import dashboard" onClick={() => importInputRef.current?.click()}>
            ↑ Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleImport}
          />
        </div>
        {importBanner && (
          <div className="mc-import-banner">{importBanner}</div>
        )}
        {panels.length === 0 ? (
          <div className="mc-dash-empty">
            <div className="mc-dash-empty-title">No panels yet</div>
            <div className="mc-dash-empty-sub">
              Click <strong>+ Add</strong> next to a metric on the left to create a panel.
              <br />
              Multiple series (even from different nodes) can be combined in the same panel.
            </div>
          </div>
        ) : (
          <div className="mc-grid">
            {panels.map(panel => (
              <ChartPanel
                key={panel.id}
                panel={panel}
                catalog={catalog}
                buffersRef={buffersRef}
                plotsRef={plotsRef}
                windowSecRef={windowSecRef}
                onRemovePanel={removePanel}
                onRemoveSeries={removeSeries}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add-to-panel popover */}
      {popover && (
        <div
          className="mc-popover"
          style={{ top: popover.top, left: popover.left }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            className="mc-popover-item"
            onClick={() => addSeriesToPanel('new', popover.key)}
          >
            + New panel
          </button>
          {panels.map(p => (
            <button
              key={p.id}
              className="mc-popover-item"
              onClick={() => addSeriesToPanel(p.id, popover.key)}
            >
              Add to: {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default MetricsView;
