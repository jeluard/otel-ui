// ── StatisticsView: statistical overview of collected traces ─────────────────

import React, {
  useMemo,
  useRef,
  useCallback,
  useLayoutEffect,
  useState,
  useEffect,
} from 'react';
import type { TraceComplete } from '../core/types.ts';
import { pctile, fmtDur, fmtTime } from '../core/utils.ts';
import { targetColor } from '../core/colors.ts';

// ── Stats computation ─────────────────────────────────────────────────────────

interface DurationStats {
  count:  number;
  min:    number;
  max:    number;
  mean:   number;
  p50:    number;
  p75:    number;
  p95:    number;
  p99:    number;
  sorted: number[];
}

function computeDurationStats(traces: TraceComplete[]): DurationStats | null {
  if (!traces.length) return null;
  const sorted = traces.map(t => t.duration_ms).sort((a, b) => a - b);
  const mean   = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    count: sorted.length,
    min:   sorted[0],
    max:   sorted[sorted.length - 1],
    mean,
    p50:   pctile(sorted, 0.50),
    p75:   pctile(sorted, 0.75),
    p95:   pctile(sorted, 0.95),
    p99:   pctile(sorted, 0.99),
    sorted,
  };
}

interface OpStats {
  name:       string;
  target:     string;
  count:      number;
  mean:       number;
  p50:        number;
  p95:        number;
  max:        number;
  errorCount: number;
}

function computeOpStats(traces: TraceComplete[]): OpStats[] {
  const map = new Map<string, { durs: number[]; errors: number }>();
  for (const trace of traces) {
    for (const span of trace.spans) {
      const key   = `${span.target}\x00${span.name}`;
      const entry = map.get(key) ?? { durs: [], errors: 0 };
      entry.durs.push(span.duration_ms);
      if (span.status === 'error') entry.errors++;
      map.set(key, entry);
    }
  }
  return Array.from(map.entries()).map(([key, { durs, errors }]) => {
    const [target, name] = key.split('\x00');
    const sorted = durs.slice().sort((a, b) => a - b);
    const mean   = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    return {
      name,
      target,
      count:      sorted.length,
      mean,
      p50:        pctile(sorted, 0.5),
      p95:        pctile(sorted, 0.95),
      max:        sorted[sorted.length - 1],
      errorCount: errors,
    };
  }).sort((a, b) => b.mean - a.mean);
}

// ── Scatter plot: one dot per trace, Y = log-scale duration, X = arrival order ─

const SCATTER_PAD = { l: 46, r: 40, t: 12, b: 28 };

function DurationScatter({ traces, stats }: { traces: TraceComplete[]; stats: DurationStats }) {
  const wrapRef    = useRef<HTMLDivElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const tipRef     = useRef<HTMLDivElement>(null);
  const orderedRef = useRef<TraceComplete[]>([]);

  const getCoordFns = useCallback((W: number, plotH: number) => {
    const { l, r, t } = SCATTER_PAD;
    const plotW = W - l - r;
    const n     = orderedRef.current.length;
    const vMin  = Math.max(0.01, stats.min);
    const vMax  = Math.max(vMin * 10, stats.max);
    const logMin = Math.log10(vMin);
    const logMax = Math.log10(vMax);
    const toY = (ms: number) =>
      t + plotH - ((Math.log10(Math.max(0.01, ms)) - logMin) / (logMax - logMin)) * plotH;
    const toX = (i: number) =>
      l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    return { toX, toY, plotW, logMin, logMax };
  }, [stats]);

  const draw = useCallback(() => {
    const wrap   = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || !traces.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = wrap.clientWidth;
    const H   = 170;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = `${W}px`;
    canvas.style.height = `${H}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const { l, r, t, b } = SCATTER_PAD;
    const plotW = W - l - r;
    const plotH = H - t - b;

    orderedRef.current = [...traces].sort((a, b) => a.started_at - b.started_at);
    const ordered = orderedRef.current;
    const n = ordered.length;

    const { toX, toY } = getCoordFns(W, plotH);

    // Y grid lines at decade boundaries
    const decades = [0.01, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 60000];
    ctx.font = `9px 'JetBrains Mono', monospace`;
    for (const v of decades) {
      const y = toY(v);
      if (y < t - 1 || y > t + plotH + 1) continue;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + plotW, y); ctx.stroke();
      ctx.fillStyle   = '#334155';
      ctx.textAlign   = 'right';
      ctx.fillText(fmtDur(v), l - 6, y + 3);
    }

    // P-tile bands
    const band = (lo: number, hi: number, color: string) => {
      const y1 = toY(hi), y2 = toY(lo);
      if (y1 > t + plotH || y2 < t) return;
      ctx.fillStyle   = color;
      ctx.globalAlpha = 0.04;
      ctx.fillRect(l, Math.max(t, y1), plotW, Math.min(t + plotH, y2) - Math.max(t, y1));
      ctx.globalAlpha = 1;
    };
    band(stats.p50, stats.p95, '#fb923c');
    band(stats.p95, stats.max, '#f43f5e');

    const PLINES = [
      { val: stats.p50, color: '#fbbf24', label: 'P50' },
      { val: stats.p95, color: '#fb923c', label: 'P95' },
      { val: stats.p99, color: '#f43f5e', label: 'P99' },
    ];
    for (const { val, color, label } of PLINES) {
      const y = toY(val);
      if (y < t || y > t + plotH) continue;
      ctx.strokeStyle  = color;
      ctx.lineWidth    = 1;
      ctx.globalAlpha  = 0.45;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle   = color;
      ctx.font        = `bold 8px 'JetBrains Mono', monospace`;
      ctx.textAlign   = 'left';
      ctx.fillText(label, l + plotW + 5, y + 3);
    }

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(l, t); ctx.lineTo(l, t + plotH + 1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(l, t + plotH); ctx.lineTo(l + plotW, t + plotH); ctx.stroke();

    // X-axis time ticks: pick up to 6 evenly-spaced indices
    const tickCount  = Math.min(6, n);
    const tickAligns: CanvasTextAlign[] = [];
    ctx.font      = `9px 'JetBrains Mono', monospace`;
    ctx.fillStyle = '#334155';
    for (let ti = 0; ti < tickCount; ti++) {
      const idx   = tickCount === 1 ? 0 : Math.round(ti / (tickCount - 1) * (n - 1));
      const trace = ordered[idx];
      const x     = toX(idx);
      // tick mark
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(x, t + plotH); ctx.lineTo(x, t + plotH + 4); ctx.stroke();
      // label
      let align: CanvasTextAlign = 'center';
      if (ti === 0)            align = 'left';
      if (ti === tickCount - 1) align = 'right';
      tickAligns.push(align);
      ctx.textAlign = align;
      ctx.fillStyle = '#334155';
      ctx.fillText(fmtTime(trace.started_at), x, t + plotH + 15);
    }

    // Dots
    const layers = [
      ordered.filter(t2 => t2.duration_ms <= stats.p50 && !t2.spans.some(s => s.status === 'error')),
      ordered.filter(t2 => t2.duration_ms > stats.p50 && t2.duration_ms <= stats.p95 && !t2.spans.some(s => s.status === 'error')),
      ordered.filter(t2 => t2.duration_ms > stats.p95 && !t2.spans.some(s => s.status === 'error')),
      ordered.filter(t2 => t2.spans.some(s => s.status === 'error')),
    ];
    const dotColors = ['#22d3ee', '#fbbf24', '#fb923c', '#f87171'];
    const dotAlphas = [0.55, 0.7, 0.85, 1.0];
    const dotRadii  = [2, 2.5, 3, 3];

    for (let li = 0; li < layers.length; li++) {
      ctx.fillStyle   = dotColors[li];
      ctx.globalAlpha = dotAlphas[li];
      for (const tr of layers[li]) {
        const i  = ordered.indexOf(tr);
        const cx = toX(i);
        const cy = Math.max(t + 2, Math.min(t + plotH - 2, toY(tr.duration_ms)));
        ctx.beginPath();
        ctx.arc(cx, cy, dotRadii[li], 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }, [traces, stats, getCoordFns]);

  // Hover — find nearest dot and show tooltip
  useEffect(() => {
    const canvas = canvasRef.current;
    const tip    = tipRef.current;
    const wrap   = wrapRef.current;
    if (!canvas || !tip || !wrap) return;

    const onMove = (e: MouseEvent) => {
      const ordered = orderedRef.current;
      if (!ordered.length) { tip.style.display = 'none'; return; }

      const rect  = canvas.getBoundingClientRect();
      const cssX  = e.clientX - rect.left;
      const cssY  = e.clientY - rect.top;
      const W     = rect.width;
      const { l, r, t: pt, b } = SCATTER_PAD;
      const plotH = rect.height - pt - b;
      const plotW = W - l - r;

      if (cssX < l - 6 || cssX > l + plotW + 6 || cssY < pt - 6 || cssY > pt + plotH + 6) {
        tip.style.display = 'none'; return;
      }

      const { toX, toY } = getCoordFns(W, plotH);
      const n = ordered.length;

      // Find the index closest in X
      const frac     = Math.max(0, Math.min(1, (cssX - l) / plotW));
      const approx   = Math.round(frac * (n - 1));
      const SEARCH   = 8; // check nearby indices
      let best: TraceComplete | null = null;
      let bestDist = Infinity;
      for (let di = -SEARCH; di <= SEARCH; di++) {
        const idx = Math.max(0, Math.min(n - 1, approx + di));
        const tr  = ordered[idx];
        const dx  = cssX - toX(idx);
        const dy  = cssY - Math.max(pt + 2, Math.min(pt + plotH - 2, toY(tr.duration_ms)));
        const d2  = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; best = tr; }
      }

      // Only show if within 14px of the dot
      if (!best || Math.sqrt(bestDist) > 14) { tip.style.display = 'none'; return; }

      const hasErr  = best.spans.some(s => s.status === 'error');
      const errCnt  = best.spans.filter(s => s.status === 'error').length;
      const durColor = best.duration_ms > stats.p95 ? '#fb923c'
                     : best.duration_ms > stats.p50 ? '#fbbf24'
                     : '#22d3ee';
      tip.innerHTML = [
        `<div class="sc-tip-name">${best.root_span_name || '(unknown)'}</div>`,
        `<div class="sc-tip-row"><span class="sc-tip-label">Duration</span>` +
          `<span class="sc-tip-val" style="color:${durColor}">${fmtDur(best.duration_ms)}</span></div>`,
        `<div class="sc-tip-row"><span class="sc-tip-label">Time</span>` +
          `<span class="sc-tip-val">${fmtTime(best.started_at)}</span></div>`,
        `<div class="sc-tip-row"><span class="sc-tip-label">Spans</span>` +
          `<span class="sc-tip-val">${best.spans.length}</span></div>`,
        hasErr
          ? `<div class="sc-tip-row"><span class="sc-tip-label">Errors</span>` +
            `<span class="sc-tip-val" style="color:#f87171">${errCnt}</span></div>`
          : '',
      ].join('');

      tip.style.display = 'block';
      const pad = 12;
      let tx = e.clientX + pad;
      let ty = e.clientY + pad;
      tip.style.left = `${tx}px`;
      tip.style.top  = `${ty}px`;
      // Keep in viewport
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      if (tx + tw > window.innerWidth  - 8) tx = e.clientX - tw - pad;
      if (ty + th > window.innerHeight - 8) ty = e.clientY - th - pad;
      tip.style.left = `${tx}px`;
      tip.style.top  = `${ty}px`;
    };
    const onLeave = () => { tip.style.display = 'none'; };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, [stats, getCoordFns]);

  useLayoutEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div ref={wrapRef} style={{ padding: '8px 16px 2px' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <div ref={tipRef} className="sc-tip" style={{ display: 'none' }} />
    </div>
  );
}

// ── Percentile bar ────────────────────────────────────────────────────────────

function PtileBar({ stats }: { stats: DurationStats }) {
  const tiles = [
    { label: 'Min',  value: fmtDur(stats.min),  color: '#475569' },
    { label: 'Mean', value: fmtDur(stats.mean), color: '#94a3b8' },
    { label: 'P50',  value: fmtDur(stats.p50),  color: '#22d3ee' },
    { label: 'P75',  value: fmtDur(stats.p75),  color: '#fbbf24' },
    { label: 'P95',  value: fmtDur(stats.p95),  color: '#fb923c' },
    { label: 'P99',  value: fmtDur(stats.p99),  color: '#f87171' },
    { label: 'Max',  value: fmtDur(stats.max),  color: '#f43f5e' },
  ] as const;

  // Segments: 0→P50, P50→P95, P95→Max (using sqrt scale to compress extremes visually)
  const scale = (v: number) => Math.sqrt(Math.max(0, v));
  const total = scale(stats.max);
  const segments = [
    { width: scale(stats.p50)               / total * 100, color: '#22d3ee' },
    { width: (scale(stats.p95) - scale(stats.p50)) / total * 100, color: '#fb923c' },
    { width: (scale(stats.max) - scale(stats.p95)) / total * 100, color: '#f43f5e' },
  ];

  return (
    <div style={{ padding: '4px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.04)', gap: 1 }}>
        {segments.map((s, i) => (
          <div key={i} style={{ width: `${Math.max(1, s.width)}%`, background: s.color, borderRadius: 2 }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {tiles.map(({ label, value, color }) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="pbar-label">{label}</span>
            <span className="pbar-value" style={{ color }}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface StatisticsViewProps {
  traces:    TraceComplete[];
  totalSeen: number;
}

const REFRESH_PRESETS = [5, 10, 30, 60, 120];

export default function StatisticsView({ traces, totalSeen }: StatisticsViewProps) {
  // ── Frozen snapshot — auto-populates on first data, then auto-refreshes ─────
  const [snapshot,      setSnapshot]      = useState<TraceComplete[]>([]);
  const [snapshotTotal, setSnapshotTotal] = useState(0);
  const [lastRefresh,   setLastRefresh]   = useState<Date | null>(null);
  const [intervalSec,   setIntervalSec]   = useState(10);
  const [countdown,     setCountdown]     = useState(10);
  const [editingFreq,   setEditingFreq]   = useState(false);
  const [freqInput,     setFreqInput]     = useState('10');
  const tracesRef    = useRef(traces);
  const totalRef     = useRef(totalSeen);
  tracesRef.current  = traces;
  totalRef.current   = totalSeen;

  const hasAutoLoaded = useRef(false);
  const refresh = useCallback(() => {
    if (tracesRef.current.length === 0) return;
    hasAutoLoaded.current = true;
    setSnapshot([...tracesRef.current]);
    setSnapshotTotal(totalRef.current);
    setLastRefresh(new Date());
  }, []);

  // First auto-load
  useEffect(() => {
    if (!hasAutoLoaded.current && traces.length > 0) refresh();
  }, [traces.length, refresh]);

  // Auto-refresh interval
  useEffect(() => {
    setCountdown(intervalSec);
    const tick = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { refresh(); return intervalSec; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [refresh, intervalSec]);

  const applyFreqInput = useCallback(() => {
    const v = parseInt(freqInput, 10);
    if (!isNaN(v) && v >= 1) setIntervalSec(v);
    setEditingFreq(false);
  }, [freqInput]);

  const pending = totalSeen - snapshotTotal;

  // ── Derived stats from snapshot ──────────────────────────────────────────
  const stats   = useMemo(() => computeDurationStats(snapshot), [snapshot]);
  const opStats = useMemo(() => computeOpStats(snapshot).slice(0, 30), [snapshot]);

  const errorRate = useMemo(() => {
    if (!snapshot.length) return 0;
    return snapshot.filter(t => t.spans.some(s => s.status === 'error')).length / snapshot.length;
  }, [snapshot]);

  const avgSpans = useMemo(() => {
    if (!snapshot.length) return 0;
    return snapshot.reduce((s, t) => s + t.spans.length, 0) / snapshot.length;
  }, [snapshot]);

  if (!snapshot.length || !stats) {
    return (
      <div id="stats-view">
        <div id="stats-empty">No traces collected yet — statistics will appear as traces arrive.</div>
      </div>
    );
  }

  const outlierThreshold = stats.p95 * 1.5;
  const outliers = snapshot
    .filter(t => t.duration_ms > outlierThreshold)
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 15);

  const errCount = Math.round(errorRate * snapshot.length);

  return (
    <div id="stats-view">

      {/* ── Toolbar ── */}
      <div id="stats-toolbar">
        <span id="stats-snapshot-label">
          {snapshot.length.toLocaleString()} sampled
          {snapshotTotal > 0 && snapshotTotal >= snapshot.length
            ? ` of ${snapshotTotal.toLocaleString()} total`
            : ''}
        </span>
        {lastRefresh && (
          <span className="stats-last-refresh">
            updated {lastRefresh.toLocaleTimeString()}
          </span>
        )}
        <span className="stats-countdown" title="Next auto-refresh">
          ↺ {countdown}s
        </span>
        {editingFreq ? (
          <span className="stats-freq-editor">
            every
            <input
              className="stats-freq-input"
              type="number"
              min={1}
              value={freqInput}
              onChange={e => setFreqInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyFreqInput(); if (e.key === 'Escape') setEditingFreq(false); }}
              autoFocus
            />s
            {REFRESH_PRESETS.map(p => (
              <button key={p} className="stats-freq-preset" onClick={() => { setFreqInput(String(p)); setIntervalSec(p); setEditingFreq(false); }}>
                {p}s
              </button>
            ))}
            <button className="stats-freq-ok" onClick={applyFreqInput}>✓</button>
          </span>
        ) : (
          <button className="stats-freq-btn" onClick={() => { setFreqInput(String(intervalSec)); setEditingFreq(true); }} title="Change refresh interval">
            every {intervalSec}s
          </button>
        )}
        <button className="stats-resume-btn" onClick={() => { refresh(); setCountdown(intervalSec); }}>
          ↻ Refresh
        </button>
        {pending > 0 && (
          <span className="stats-pending-pill">{pending.toLocaleString()} new</span>
        )}
      </div>

      {/* ── Summary cards ── */}
      <div id="stats-cards">
        <StatCard
          label="Total Traces"
          value={snapshot.length.toLocaleString()}
          sub={`${opStats.length} unique operations`}
        />
        <StatCard
          label="Mean Duration"
          value={fmtDur(stats.mean)}
          sub={`min ${fmtDur(stats.min)} · max ${fmtDur(stats.max)}`}
        />
        <StatCard
          label="P50 / P95"
          value={`${fmtDur(stats.p50)} / ${fmtDur(stats.p95)}`}
          sub={`P99 ${fmtDur(stats.p99)}`}
        />
        <StatCard
          label="Error Rate"
          value={`${(errorRate * 100).toFixed(1)}%`}
          sub={`${errCount} trace${errCount !== 1 ? 's' : ''} with errors`}
          accent={errorRate > 0.05 ? '#ef4444' : errorRate > 0.01 ? '#f59e0b' : undefined}
        />
        <StatCard
          label="Avg Spans / Trace"
          value={avgSpans.toFixed(1)}
        />
        <StatCard
          label="Outliers"
          value={outliers.length.toString()}
          sub={outliers.length > 0 ? `slowest ${fmtDur(outliers[0].duration_ms)}` : 'none above 1.5× P95'}
          accent={outliers.length > 0 ? '#fb923c' : undefined}
        />
      </div>

      {/* ── Duration distribution ── */}
      <div className="stats-section">
        <div className="stats-section-header">
          <span className="stats-section-title">Duration over Time</span>
          <span className="stats-section-hint">each dot = one trace · log-Y · <span style={{ color: '#22d3ee' }}>cyan</span> ≤P50 · <span style={{ color: '#fbbf24' }}>yellow</span> P50–P95 · <span style={{ color: '#fb923c' }}>orange</span> &gt;P95 · <span style={{ color: '#f87171' }}>red</span> errors</span>
        </div>
        <DurationScatter traces={snapshot} stats={stats} />
        <PtileBar stats={stats} />
      </div>

      {/* ── Lower: operations + outliers ── */}
      <div id="stats-lower">

        {/* Operations breakdown */}
        <div className="stats-section" style={{ overflow: 'hidden', minWidth: 0 }}>
          <div className="stats-section-header">
            <span className="stats-section-title">Operations by Mean Duration</span>
            <span className="stats-section-hint">{opStats.length} operations · sorted by mean duration desc</span>
          </div>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Target</th>
                  <th style={{ textAlign: 'right' }}>Count</th>
                  <th style={{ textAlign: 'right' }}>Mean</th>
                  <th style={{ textAlign: 'right' }}>P50</th>
                  <th style={{ textAlign: 'right' }}>P95</th>
                  <th style={{ textAlign: 'right' }}>Max</th>
                  <th style={{ textAlign: 'right' }}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {opStats.map(op => {
                  const col    = targetColor(op.target);
                  const errPct = op.count > 0 ? (op.errorCount / op.count) * 100 : 0;
                  return (
                    <tr key={`${op.target}\x00${op.name}`}>
                      <td className="stats-op-name">{op.name}</td>
                      <td style={{ color: col.fill }} className="stats-op-target">{op.target}</td>
                      <td className="stats-num">{op.count.toLocaleString()}</td>
                      <td className="stats-num">{fmtDur(op.mean)}</td>
                      <td className="stats-num">{fmtDur(op.p50)}</td>
                      <td className="stats-num">{fmtDur(op.p95)}</td>
                      <td className="stats-num">{fmtDur(op.max)}</td>
                      <td className="stats-num" style={{ color: op.errorCount > 0 ? '#f87171' : undefined }}>
                        {op.errorCount > 0 ? `${op.errorCount} (${errPct.toFixed(0)}%)` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>


      </div>

      {/* ── Slowest traces: full-width expandable table ── */}
      {outliers.length > 0 && (
        <OutliersTable
          outliers={outliers}
          p95={stats.p95}
          threshold={outlierThreshold}
          onExpand={_open => {}}  // snapshot is already frozen; no need to pause
        />
      )}

    </div>
  );
}

// ── Expandable outliers table ─────────────────────────────────────────────────

function OutliersTable({
  outliers,
  p95,
  threshold,
  onExpand,
}: {
  outliers: TraceComplete[];
  p95: number;
  threshold: number;
  onExpand: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggle = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    onExpand(next !== null);
  };

  return (
    <div className="stats-section" id="stats-outliers">
      <div className="stats-section-header">
        <span className="stats-section-title">Slow Outliers</span>
        <span className="stats-section-hint">
          {outliers.length} trace{outliers.length !== 1 ? 's' : ''} above 1.5× P95
          &nbsp;({fmtDur(threshold)}) · click row for span breakdown
        </span>
      </div>
      <div className="stats-table-wrap" style={{ maxHeight: 'none' }}>
        <table className="stats-table stats-outlier-table">
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th>Time</th>
              <th>Trace ID</th>
              <th>Root span</th>
              <th style={{ textAlign: 'right' }}>Duration</th>
              <th style={{ textAlign: 'right' }}>vs P95</th>
              <th style={{ textAlign: 'right' }}>Spans</th>
              <th>Slowest span</th>
              <th>Services</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {outliers.map(t => {
              const ratio     = t.duration_ms / p95;
              const hasErr    = t.spans.some(s => s.status === 'error');
              const errSpans  = t.spans.filter(s => s.status === 'error');
              const byDur     = [...t.spans].sort((a, b) => b.duration_ms - a.duration_ms);
              const slowest   = byDur[0];
              const services  = [...new Set(t.spans.map(s => s.service_name).filter(Boolean))];
              const isOpen    = expanded === t.trace_id;
              return (
                <React.Fragment key={t.trace_id}>
                  <tr
                    className={`stats-outlier-row${isOpen ? ' stats-outlier-open' : ''}`}
                    onClick={() => toggle(t.trace_id)}
                  >
                    <td className="stats-expand-cell">
                      <span className={`stats-expand-icon${isOpen ? ' open' : ''}`}>▶</span>
                    </td>
                    <td className="stats-num" style={{ color: '#475569' }}>
                      {fmtTime(t.started_at)}
                    </td>
                    <td className="stats-num" style={{ color: '#475569' }}>
                      …{t.trace_id.slice(-12)}
                    </td>
                    <td className="stats-op-name">{t.root_span_name}</td>
                    <td className="stats-num" style={{ color: '#f43f5e', fontWeight: 700 }}>
                      {fmtDur(t.duration_ms)}
                    </td>
                    <td className="stats-num" style={{ color: '#fb923c' }}>
                      {ratio.toFixed(1)}×
                    </td>
                    <td className="stats-num">{t.spans.length}</td>
                    <td>
                      {slowest && (
                        <span className="stats-slowspan">
                          <span className="stats-slowspan-name">{slowest.name}</span>
                          <span className="stats-slowspan-dur">{fmtDur(slowest.duration_ms)}</span>
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="stats-services">
                        {services.slice(0, 4).map(svc => (
                          <span key={svc} className="stats-svc-chip"
                            style={{ color: targetColor(svc).fill }}>
                            {svc}
                          </span>
                        ))}
                        {services.length > 4 && (
                          <span className="stats-svc-more">+{services.length - 4}</span>
                        )}
                      </span>
                    </td>
                    <td>
                      {hasErr ? (
                        <span className="stats-err-badge">
                          {errSpans.length} error{errSpans.length !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span style={{ color: '#334155' }}>—</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="stats-detail-row">
                      <td colSpan={10} style={{ padding: 0 }}>
                        <div className="stats-detail-wrap">
                          <table className="stats-table stats-detail-table">
                            <thead>
                              <tr>
                                <th>Span name</th>
                                <th>Target</th>
                                <th>Service</th>
                                <th style={{ textAlign: 'right' }}>Start&nbsp;+</th>
                                <th style={{ textAlign: 'right' }}>Duration</th>
                                <th style={{ width: 60 }}>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {byDur.slice(0, 20).map(s => {
                                const col    = targetColor(s.target);
                                const relMs  = (s.start_time_unix_nano - t.started_at) / 1_000_000;
                                const isErr  = s.status === 'error';
                                const pctOfTotal = t.duration_ms > 0
                                  ? (s.duration_ms / t.duration_ms) * 100
                                  : 0;
                                return (
                                  <tr key={s.span_id}>
                                    <td style={{ paddingLeft: 8 }}>
                                      <span className="stats-op-name">{s.name}</span>
                                    </td>
                                    <td style={{ color: col.fill }} className="stats-op-target">{s.target}</td>
                                    <td className="stats-op-target" style={{ color: '#475569' }}>{s.service_name}</td>
                                    <td className="stats-num" style={{ color: '#475569' }}>+{fmtDur(relMs)}</td>
                                    <td className="stats-num">
                                      <span style={{ marginRight: 6 }}>{fmtDur(s.duration_ms)}</span>
                                      <span className="stats-pct-bar-wrap">
                                        <span
                                          className="stats-pct-bar"
                                          style={{ width: `${Math.min(100, pctOfTotal)}%` }}
                                        />
                                        <span className="stats-pct-label">{pctOfTotal.toFixed(0)}%</span>
                                      </span>
                                    </td>
                                    <td>
                                      <span className={isErr ? 'stats-err-badge' : 'stats-ok-badge'}>
                                        {isErr ? 'error' : 'ok'}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
