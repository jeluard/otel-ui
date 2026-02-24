// ── Flamegraph canvas renderer ───────────────────────────────────────────────

import type { TraceComplete, SpanEvent } from '../core/types.ts';
import { targetColor }                   from '../core/colors.ts';
import { fmtDur }                        from '../core/utils.ts';
import { C }                             from '../core/theme.ts';

export const TRC_ROW_H = 22;
export const TRC_PAD   = { t: 22, b: 14, l: 4, r: 4 } as const;

/** Given CSS-pixel coordinates relative to the canvas element, returns the
 *  hovered SpanEvent (and its start offset from trace start), or null. */
export type FlamegraphHitTest = (cssX: number, cssY: number) => { span: SpanEvent; relStartMs: number } | null;

// ── Gap compression ───────────────────────────────────────────────────────────

const GAP_PX        = 18;   // pixels allocated to each compressed gap
const GAP_THRESHOLD = 0.02; // gaps > 2 % of total trace range get compressed

interface CompressedAxis {
  toX(t: number): number;
  gaps: Array<{ x1: number; x2: number; durNs: number }>;
}

function buildAxis(
  spans:  SpanEvent[],
  tMin:   number,
  tRange: number,
  plotW:  number,
): CompressedAxis {
  // Merge overlapping span intervals to find truly idle periods
  const sorted = [...spans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
  const segs: Array<{ s: number; e: number }> = [];
  for (const sp of sorted) {
    if (segs.length && sp.start_time_unix_nano <= segs[segs.length - 1].e) {
      segs[segs.length - 1].e = Math.max(segs[segs.length - 1].e, sp.end_time_unix_nano);
    } else {
      segs.push({ s: sp.start_time_unix_nano, e: sp.end_time_unix_nano });
    }
  }

  // Collect idle gaps that are large enough to compress
  const largeGaps: Array<{ s: number; e: number }> = [];
  for (let i = 1; i < segs.length; i++) {
    const gapNs = segs[i].s - segs[i - 1].e;
    if (gapNs / tRange > GAP_THRESHOLD) largeGaps.push({ s: segs[i - 1].e, e: segs[i].s });
  }

  if (largeGaps.length === 0) {
    // No significant gaps — plain linear mapping
    return {
      toX: (t) => ((t - tMin) / tRange) * plotW,
      gaps: [],
    };
  }

  const largeGapTotalNs = largeGaps.reduce((s, g) => s + (g.e - g.s), 0);
  const activeNs  = tRange - largeGapTotalNs;
  const activeW   = plotW - largeGaps.length * GAP_PX;
  const pxPerNs   = activeW / Math.max(1, activeNs);

  const toX = (t: number): number => {
    let x = 0;
    let cursor = tMin;
    for (const gap of largeGaps) {
      if (t <= gap.s) return x + (t - cursor) * pxPerNs;
      x += (gap.s - cursor) * pxPerNs;
      cursor = gap.s;
      if (t <= gap.e) return x + ((t - gap.s) / (gap.e - gap.s)) * GAP_PX;
      x += GAP_PX;
      cursor = gap.e;
    }
    return x + (t - cursor) * pxPerNs;
  };

  return {
    toX,
    gaps: largeGaps.map(g => ({ x1: toX(g.s), x2: toX(g.e), durNs: g.e - g.s })),
  };
}

// ── Main draw function ────────────────────────────────────────────────────────

/**
 * Draw a flamegraph for `trace` onto `canvas`, applying `filterFn` to the spans.
 * Idle gaps larger than 2 % of the trace duration are compressed into a labelled
 * notch so that short but meaningful spans aren't dwarfed by inactivity.
 * Returns a hit-test function for hover tooltips.
 */
export function drawFlamegraph(
  trace:    TraceComplete,
  canvas:   HTMLCanvasElement,
  filterFn: (spans: SpanEvent[]) => SpanEvent[],
): FlamegraphHitTest {
  const area  = canvas.parentElement!;
  const rect  = area.getBoundingClientRect();
  const w     = Math.max(300, rect.width || area.offsetWidth || area.clientWidth);

  const visibleSpans = filterFn(trace.spans);
  if (visibleSpans.length === 0) return () => null;

  let tMin = Infinity, tMax = -Infinity;
  for (const s of visibleSpans) {
    if (s.start_time_unix_nano < tMin) tMin = s.start_time_unix_nano;
    if (s.end_time_unix_nano   > tMax) tMax = s.end_time_unix_nano;
  }
  const tRange = Math.max(1, tMax - tMin);
  const plotW  = w - TRC_PAD.l - TRC_PAD.r;

  // Build the compressed axis first so row-packing uses visual (pixel) coords.
  const axis = buildAxis(visibleSpans, tMin, tRange, plotW);

  const FAST_PX = 0;   // always use the bar shape (diamond glyph disabled)
  const MIN_W   = 18;  // every span bar is at least this wide (px)

  // Visual row packing: assign each span to the first row where its *rendered*
  // bar doesn't overlap the previous bar. Using pixel coords (not time) respects
  // MIN_W so that expanded short spans don't collide.
  type FgRow = { spans: SpanEvent[]; rightmostPx: number };
  const rows: FgRow[] = [];
  const allSpans = [...visibleSpans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);

  for (const span of allSpans) {
    const x0  = axis.toX(span.start_time_unix_nano);
    const x1  = axis.toX(span.end_time_unix_nano);
    const barW = Math.max(MIN_W, x1 - x0);
    const rowIdx = rows.findIndex(row => x0 >= row.rightmostPx);
    if (rowIdx === -1) {
      rows.push({ spans: [span], rightmostPx: x0 + barW + 1 });
    } else {
      rows[rowIdx].spans.push(span);
      rows[rowIdx].rightmostPx = x0 + barW + 1;
    }
  }
  if (rows.length === 0) return () => null;

  // Compute actual required canvas width: the rightmost bar edge across all rows.
  let requiredW = w;
  for (const row of rows) {
    for (const span of row.spans) {
      const x0  = TRC_PAD.l + axis.toX(span.start_time_unix_nano);
      const x1  = TRC_PAD.l + axis.toX(span.end_time_unix_nano);
      const barW = Math.max(MIN_W, x1 - x0);
      requiredW = Math.max(requiredW, x0 + barW + TRC_PAD.r);
    }
  }
  const totalW  = Math.ceil(requiredW);
  const canvasH = TRC_PAD.t + rows.length * TRC_ROW_H + TRC_PAD.b;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = totalW * dpr;
  canvas.height = canvasH * dpr;
  canvas.style.width  = `${totalW}px`;
  canvas.style.height = `${canvasH}px`;

  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, totalW, canvasH);
  ctx.fillStyle = 'rgba(8,14,28,0.98)';
  ctx.fillRect(0, 0, totalW, canvasH);

  // ── Compressed-gap bands (draw before spans so they appear behind) ──────
  if (axis.gaps.length > 0) {
    ctx.save();
    for (const gap of axis.gaps) {
      const gx = TRC_PAD.l + gap.x1;
      const gw = gap.x2 - gap.x1;
      // Subtle hatched fill
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(gx, TRC_PAD.t, gw, canvasH - TRC_PAD.t - TRC_PAD.b);
      // Diagonal stripes
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth   = 1;
      const stripeStep = 4;
      const h = canvasH - TRC_PAD.t - TRC_PAD.b;
      ctx.save();
      ctx.beginPath(); ctx.rect(gx, TRC_PAD.t, gw, h); ctx.clip();
      for (let s = -h; s < gw + h; s += stripeStep) {
        ctx.beginPath();
        ctx.moveTo(gx + s,     TRC_PAD.t);
        ctx.lineTo(gx + s + h, TRC_PAD.t + h);
        ctx.stroke();
      }
      ctx.restore();
      // Left/right edge ticks
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(gx,      TRC_PAD.t); ctx.lineTo(gx,      canvasH - TRC_PAD.b); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(gx + gw, TRC_PAD.t); ctx.lineTo(gx + gw, canvasH - TRC_PAD.b); ctx.stroke();
      ctx.setLineDash([]);
      // Duration label centred in the notch
      ctx.font         = '8px JetBrains Mono,monospace';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign    = 'center';
      ctx.fillStyle    = 'rgba(255,255,255,0.22)';
      ctx.fillText(fmtDur(gap.durNs / 1e6), gx + gw / 2, TRC_PAD.t - 5);
    }
    ctx.restore();
  }

  // ── Vertical grid lines (only in uncompressed regions) ──────────────────
  {
    const gridN = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    for (let i = 1; i < gridN; i++) {
      const gx = TRC_PAD.l + (i / gridN) * plotW;
      // Skip if this x falls inside a compressed gap
      const inGap = axis.gaps.some(g => gx >= TRC_PAD.l + g.x1 && gx <= TRC_PAD.l + g.x2);
      if (inGap) continue;
      ctx.beginPath(); ctx.moveTo(gx, TRC_PAD.t); ctx.lineTo(gx, canvasH - TRC_PAD.b); ctx.stroke();
    }
  }

  // ── Span bars ────────────────────────────────────────────────────────────

  // Collect hit-test rects as we draw (CSS pixels)
  const hitRects: Array<{ x0: number; y: number; bw: number; span: SpanEvent; relStartMs: number }> = [];

  ctx.save();
  ctx.font         = '10px JetBrains Mono,monospace';
  ctx.textBaseline = 'middle';
  for (let depth = 0; depth < rows.length; depth++) {
    for (const span of rows[depth].spans) {
    const x0 = TRC_PAD.l + axis.toX(span.start_time_unix_nano);
    const x1 = TRC_PAD.l + axis.toX(span.end_time_unix_nano);
    const naturalW = x1 - x0;
    const isFast   = naturalW < FAST_PX;
    const bw       = isFast ? MIN_W : Math.max(MIN_W, naturalW);
    const y        = TRC_PAD.t + depth * TRC_ROW_H;
    const col      = targetColor(span.target);
    const relStartMs = (span.start_time_unix_nano - tMin) / 1e6;
    hitRects.push({ x0, y, bw: Math.max(bw, 6), span, relStartMs });

    if (isFast) {
      const cx = x0 + naturalW / 2;
      const cy = y + TRC_ROW_H / 2;
      const hw = MIN_W / 2;
      const hh = (TRC_ROW_H - 4) / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
      ctx.closePath();
      ctx.fillStyle   = col.fill;
      ctx.shadowColor = col.fill;
      ctx.shadowBlur  = 4;
      ctx.fill();
      ctx.shadowBlur  = 0;
    } else {
      ctx.fillStyle = col.fill + 'cc';
      if ((ctx as any).roundRect) {
        ctx.beginPath();
        (ctx as any).roundRect(x0, y + 1, bw - 1, TRC_ROW_H - 3, 3);
        ctx.fill();
      } else {
        ctx.fillRect(x0, y + 1, bw - 1, TRC_ROW_H - 3);
      }
      if (bw > 20) {
        ctx.fillStyle = col.text;
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 3, y, bw - 6, TRC_ROW_H); ctx.clip();
        ctx.fillText(span.name, x0 + 4, y + TRC_ROW_H / 2);
        ctx.restore();
      }
    }
    } // end spans in row
  } // end rows
  ctx.restore();

  // ── Build hit-test function ──────────────────────────────────────────────
  const hitTest: FlamegraphHitTest = (cssX, cssY) => {
    // Iterate in reverse so topmost (last drawn) spans take priority
    for (let i = hitRects.length - 1; i >= 0; i--) {
      const r = hitRects[i];
      if (cssX >= r.x0 && cssX <= r.x0 + r.bw &&
          cssY >= r.y  && cssY <= r.y + TRC_ROW_H) {
        return { span: r.span, relStartMs: r.relStartMs };
      }
    }
    return null;
  };

  // ── Time axis (top) ──────────────────────────────────────────────────────
  ctx.font         = '9px JetBrains Mono,monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle    = C.dim;
  ctx.textAlign    = 'left';
  ctx.fillText('0', TRC_PAD.l, TRC_PAD.t - 5);
  ctx.textAlign    = 'right';
  ctx.fillText(fmtDur(tRange / 1e6), totalW - TRC_PAD.r, TRC_PAD.t - 5);
  if (axis.gaps.length === 0) {
    // Only draw intermediate time labels when there's no compression (they'd be misleading otherwise)
    ctx.textAlign = 'center';
    const gridN = 5;
    for (let i = 1; i < gridN; i++) {
      const gx = TRC_PAD.l + (i / gridN) * plotW;
      ctx.fillText(fmtDur((tRange / 1e6) * (i / gridN)), gx, TRC_PAD.t - 5);
    }
  }

  return hitTest;
}
