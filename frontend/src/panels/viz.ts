// ── VizPanel: sparkline + latency heatmap for the node detail panel ──────────

import type { SpanEvent }                             from '../core/types.ts';
import { pctile, fmtDur, msToHmRow, hmCellColor, HM_EDGES, HM_ROWS } from '../core/utils.ts';
import { C }                                          from '../core/theme.ts';

// ── Shared constants ──────────────────────────────────────────────────────────

export const VIZ_W = 388;
export const VIZ_H = 80;

const SL_MAX_PTS    = 80;
const SL_PX_PER_SEC = 12;
const SL_RANGE_DECAY = 0.0025;

// Sparkline layout — hoisted so hover and draw share the same geometry
const SL_PAD_L = 36, SL_PAD_R = 56, SL_PAD_T = 6, SL_PAD_B = 14;
const SL_PW = VIZ_W - SL_PAD_L - SL_PAD_R;
const SL_SLOT_W    = SL_PW / (SL_MAX_PTS - 1);
const SL_MS_PER_SLOT = (SL_SLOT_W / SL_PX_PER_SEC) * 1000;

const HM_COLS       = 20;
const HM_PX_PER_SEC = 12;
const HM_Y_W        = 38;  // left gutter for Y-axis tick labels
const HM_R_W        = 56;  // right gutter for P50/P95 labels
const HM_X_H        = 13;

export type VizMode = 'sparkline' | 'heatmap';

// ── VizPanel ──────────────────────────────────────────────────────────────────

export class VizPanel {
  readonly slCanvas: HTMLCanvasElement;
  readonly hmCanvas: HTMLCanvasElement;
  private  readonly slCtx: CanvasRenderingContext2D;
  private  readonly hmCtx: CanvasRenderingContext2D;
  private  readonly spkTip: HTMLDivElement;

  vizMode: VizMode = 'sparkline';

  // Sparkline conveyor-belt state
  slDisplayBuf: number[] = [];
  slIncomingQ:  number[] = [];
  private slPhase    = 0;
  private slRangeMin = 0;
  private slRangeMax = 1;

  // Heatmap state
  private hmGrid: number[][] = this._emptyGrid();
  hmAccBuf: number[] = [];
  private hmPhase = 0;
  private lastHmState: { grid: number[][]; maxCnt: number; cellW: number; cellH: number; plotW: number } | null = null;

  constructor(container: HTMLElement) {
    const dpr = window.devicePixelRatio || 1;

    // Sparkline canvas
    this.slCanvas = document.createElement('canvas');
    this.slCanvas.width  = VIZ_W * dpr;
    this.slCanvas.height = VIZ_H * dpr;
    this.slCanvas.style.width  = `${VIZ_W}px`;
    this.slCanvas.style.height = `${VIZ_H}px`;
    container.appendChild(this.slCanvas);
    this.slCtx = this.slCanvas.getContext('2d')!;
    this.slCtx.scale(dpr, dpr);

    // Heatmap canvas (starts hidden)
    this.hmCanvas = document.createElement('canvas');
    this.hmCanvas.width  = VIZ_W * dpr;
    this.hmCanvas.height = VIZ_H * dpr;
    this.hmCanvas.style.width  = `${VIZ_W}px`;
    this.hmCanvas.style.height = `${VIZ_H}px`;
    this.hmCanvas.style.display = 'none';
    container.appendChild(this.hmCanvas);
    this.hmCtx = this.hmCanvas.getContext('2d')!;
    this.hmCtx.scale(dpr, dpr);

    // Shared hover tooltip (appended to body so it floats above everything)
    this.spkTip = document.createElement('div');
    this.spkTip.id = 'spk-tip';
    document.body.appendChild(this.spkTip);

    // Wire tab buttons
    document.querySelectorAll<HTMLButtonElement>('.nd-viz-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset['viz'] as VizMode;
        this.vizMode = mode;
        document.querySelectorAll('.nd-viz-tab').forEach(b => b.classList.toggle('active', b === btn));
        this.slCanvas.style.display = mode === 'sparkline' ? 'block' : 'none';
        this.hmCanvas.style.display = mode === 'heatmap'   ? 'block' : 'none';
      });
    });

    // Sparkline hover
    this.slCanvas.addEventListener('mousemove', (e) => {
      if (this.slDisplayBuf.length < 2) return;
      const rect  = this.slCanvas.getBoundingClientRect();
      const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const n     = this.slDisplayBuf.length;
      const idx   = Math.round(pct * (n - 1));
      const val   = this.slDisplayBuf[idx];
      const ago    = n - 1 - idx;
      const agoStr = ago === 0 ? 'latest' : `${fmtDur(ago * SL_MS_PER_SLOT)} ago`;
      this.spkTip.textContent = `${fmtDur(val)} (${agoStr})`;
      this.spkTip.style.left    = `${e.clientX + 12}px`;
      this.spkTip.style.top     = `${e.clientY - 28}px`;
      this.spkTip.style.opacity = '1';
    });
    this.slCanvas.addEventListener('mouseleave', () => { this.spkTip.style.opacity = '0'; });

    // Heatmap hover
    this.hmCanvas.addEventListener('mousemove', (e) => {
      if (!this.lastHmState) return;
      const { grid, cellW, cellH, plotW: hmPlotW } = this.lastHmState;
      const rect  = this.hmCanvas.getBoundingClientRect();
      const mx    = e.clientX - rect.left;
      const my    = e.clientY - rect.top;
      if (mx < HM_Y_W || mx > HM_Y_W + hmPlotW || my > VIZ_H - HM_X_H) { this.spkTip.style.opacity = '0'; return; }
      const col = Math.min(HM_COLS - 1, Math.floor((mx - HM_Y_W) / cellW));
      const row = Math.min(HM_ROWS - 1, HM_ROWS - 1 - Math.floor(my / cellH));
      const cnt  = grid[col]?.[row] ?? 0;
      const lo   = HM_EDGES[row] as number;
      const hi   = HM_EDGES[row + 1] as number;
      const loS  = lo === 0 ? '0' : fmtDur(lo);
      const hiS  = hi === Infinity ? '+' : `\u2013${fmtDur(hi)}`;
      this.spkTip.textContent = `${loS}${hiS}: ${cnt} span${cnt !== 1 ? 's' : ''}`;
      this.spkTip.style.left    = `${e.clientX + 12}px`;
      this.spkTip.style.top     = `${e.clientY - 28}px`;
      this.spkTip.style.opacity = '1';
    });
    this.hmCanvas.addEventListener('mouseleave', () => { this.spkTip.style.opacity = '0'; });
  }

  private _emptyGrid(): number[][] {
    return Array.from({ length: HM_COLS }, () => new Array(HM_ROWS).fill(0));
  }

  /**
   * Seed state from existing span history when opening a new node.
   * Shows an immediate chart rather than waiting for new spans.
   */
  seed(durations: number[]): void {
    const seedDurs = durations.slice(0, SL_MAX_PTS).reverse(); // oldest→newest

    this.slDisplayBuf = seedDurs;
    this.slIncomingQ  = [];
    this.slPhase      = 0;
    if (seedDurs.length) {
      this.slRangeMin = Math.min(...seedDurs);
      this.slRangeMax = Math.max(...seedDurs);
    } else {
      this.slRangeMin = 0;
      this.slRangeMax = 1;
    }

    // Seed heatmap: replicate aggregate distribution across every column so
    // the initial view is stable before live data overwrites the rightmost columns.
    this.hmGrid   = this._emptyGrid();
    this.hmPhase  = 0;
    this.hmAccBuf = [];
    if (seedDurs.length > 0) {
      const agg = new Array(HM_ROWS).fill(0);
      for (const d of seedDurs) agg[msToHmRow(d)]++;
      for (let c = 0; c < HM_COLS; c++)
        for (let r = 0; r < HM_ROWS; r++) this.hmGrid[c][r] = agg[r];
    }
  }

  /** Push a new duration when a span arrives for the selected node. */
  pushDuration(ms: number): void {
    this.slIncomingQ.push(ms);
    this.hmAccBuf.push(ms);
  }

  /** Called from the frame loop every frame while a node is selected. */
  draw(now: number, dt: number, selectedNodeId: string | null, nodeSpans: Map<string, SpanEvent[]>): void {
    if (!selectedNodeId) return;
    if (this.vizMode === 'sparkline') this._drawSparkline(now, dt, selectedNodeId, nodeSpans);
    else this._drawHeatmap(dt, selectedNodeId, nodeSpans);
  }

  // ── Sparkline ──────────────────────────────────────────────────────────────

  private _drawSparkline(_now: number, dt: number, selectedNodeId: string, nodeSpans: Map<string, SpanEvent[]>): void {
    const w = VIZ_W, h = VIZ_H;
    const PAD_L = SL_PAD_L, PAD_B = SL_PAD_B, PAD_T = SL_PAD_T, PAD_R = SL_PAD_R;
    const pw = SL_PW;
    const ph = h - PAD_T - PAD_B;
    const slotW = SL_SLOT_W;

    this.slPhase += SL_PX_PER_SEC * (dt / 1000);
    while (this.slPhase >= slotW) {
      this.slPhase -= slotW;
      // When no new span arrived in this slot, record 0 so the line decays
      // to the baseline rather than staying flat at the last observed value.
      const next = this.slIncomingQ.length > 0 ? this.slIncomingQ.shift()! : 0;
      if (true) {
        this.slDisplayBuf.push(next);
        if (this.slDisplayBuf.length > SL_MAX_PTS) this.slDisplayBuf.shift();
      }
    }

    const n   = this.slDisplayBuf.length;
    const ctx = this.slCtx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,14,28,0.72)';
    ctx.fillRect(PAD_L, PAD_T, pw, ph);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 0.5;
    for (let t = 0; t <= 2; t++) {
      const yy = PAD_T + (t / 2) * ph;
      ctx.beginPath(); ctx.moveTo(PAD_L, yy); ctx.lineTo(w - PAD_R, yy); ctx.stroke();
    }

    if (n < 2) {
      ctx.fillStyle    = 'rgba(100,116,139,0.40)';
      ctx.font         = '9px JetBrains Mono,monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('waiting for data…', PAD_L + pw / 2, PAD_T + ph / 2);
      return;
    }

    const px = (i: number) => PAD_L + pw - this.slPhase - (n - 1 - i) * slotW;

    let localMin = Infinity, localMax = -Infinity;
    for (const v of this.slDisplayBuf) {
      if (v < localMin) localMin = v;
      if (v > localMax) localMax = v;
    }
    this.slRangeMin += (localMin - this.slRangeMin) * SL_RANGE_DECAY * dt;
    this.slRangeMax += (localMax - this.slRangeMax) * SL_RANGE_DECAY * dt;
    const range = Math.max(this.slRangeMax - this.slRangeMin, 0.01);
    const py    = (v: number) => PAD_T + ph - ((v - this.slRangeMin) / range) * ph;

    ctx.save();
    ctx.beginPath(); ctx.rect(PAD_L, PAD_T, pw, ph); ctx.clip();

    const smoothPath = () => {
      ctx.moveTo(px(0), py(this.slDisplayBuf[0]));
      for (let i = 1; i < n - 1; i++) {
        const mx = (px(i) + px(i + 1)) / 2;
        const my = (py(this.slDisplayBuf[i]) + py(this.slDisplayBuf[i + 1])) / 2;
        ctx.quadraticCurveTo(px(i), py(this.slDisplayBuf[i]), mx, my);
      }
      ctx.quadraticCurveTo(px(n - 2), py(this.slDisplayBuf[n - 2]), px(n - 1), py(this.slDisplayBuf[n - 1]));
    };

    const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + ph);
    grad.addColorStop(0, 'rgba(96,200,255,0.14)');
    grad.addColorStop(1, 'rgba(96,200,255,0)');
    ctx.beginPath(); smoothPath();
    ctx.lineTo(px(n - 1), PAD_T + ph); ctx.lineTo(px(0), PAD_T + ph); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath(); smoothPath();
    ctx.strokeStyle = C.dotActive;
    ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

    const newestY = py(this.slDisplayBuf[n - 1]);
    ctx.beginPath(); ctx.arc(px(n - 1), newestY, 3, 0, Math.PI * 2);
    ctx.fillStyle = C.sparkline; ctx.shadowColor = C.sparkline; ctx.shadowBlur = 6; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Y-axis labels (left side)
    ctx.fillStyle = `rgba(${C.subtleRgb},0.60)`;
    ctx.font      = '8px JetBrains Mono,monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    for (let t = 0; t <= 2; t++) {
      const v  = this.slRangeMin + ((2 - t) / 2) * range;
      const yy = PAD_T + (t / 2) * ph;
      ctx.fillText(fmtDur(v), PAD_L - 3, yy + 3);
    }

    // P50 guide (computed from full nodeSpans history)
    const spans = nodeSpans.get(selectedNodeId) ?? [];
    const durs  = spans.map(s => s.duration_ms).filter(d => d > 0);
    if (durs.length >= 3) {
      const s2  = [...durs].sort((a, b) => a - b);
      const p50 = pctile(s2, 0.50);
      const p50y = py(p50);
      if (p50y >= PAD_T && p50y <= PAD_T + ph) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(PAD_L, p50y); ctx.lineTo(w - PAD_R, p50y);
        ctx.strokeStyle = C.p50; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.p50; ctx.font = 'bold 8px JetBrains Mono,monospace';
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(`p50 ${fmtDur(p50)}`, w - 2, p50y - 2);
        ctx.restore();
      }
    }

    ctx.fillStyle = 'rgba(100,116,139,0.45)';
    ctx.font      = '8px JetBrains Mono,monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';  ctx.fillText('older', PAD_L + 2, h - 2);
    ctx.textAlign = 'right'; ctx.fillText('now', w - PAD_R, h - 2);
  }

  // ── Heatmap ───────────────────────────────────────────────────────────────

  private _drawHeatmap(dt: number, selectedNodeId: string, nodeSpans: Map<string, SpanEvent[]>): void {
    const w = VIZ_W;
    const h = VIZ_H;
    const ctx = this.hmCtx;

    const plotW = w - HM_Y_W - HM_R_W;
    const plotH = h - HM_X_H;
    const cellW = plotW / HM_COLS;
    const cellH = plotH / HM_ROWS;

    this.hmPhase += HM_PX_PER_SEC * (dt / 1000);
    while (this.hmPhase >= cellW) {
      this.hmPhase -= cellW;
      this.hmGrid.shift();
      const col = new Array(HM_ROWS).fill(0);
      for (const v of this.hmAccBuf) col[msToHmRow(v)]++;
      this.hmAccBuf = [];
      this.hmGrid.push(col);
    }

    let maxCnt = 0;
    for (let c = 0; c < HM_COLS; c++)
      for (let r = 0; r < HM_ROWS; r++)
        if (this.hmGrid[c][r] > maxCnt) maxCnt = this.hmGrid[c][r];
    this.lastHmState = { grid: this.hmGrid, maxCnt, cellW, cellH, plotW };

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,14,28,0.72)';
    ctx.fillRect(HM_Y_W, 0, plotW, plotH);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
    for (let r = 1; r < HM_ROWS; r++) {
      const y = r * cellH;
      ctx.beginPath(); ctx.moveTo(HM_Y_W, y); ctx.lineTo(HM_Y_W + plotW, y); ctx.stroke();
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(HM_Y_W, 0, plotW, plotH); ctx.clip();
    if (maxCnt > 0) {
      for (let c = 0; c < HM_COLS; c++) {
        for (let r = 0; r < HM_ROWS; r++) {
          if (!this.hmGrid[c][r]) continue;
          ctx.fillStyle = hmCellColor(this.hmGrid[c][r] / maxCnt);
          const cx = HM_Y_W + c * cellW - this.hmPhase;
          ctx.fillRect(cx + 0.5, (HM_ROWS - 1 - r) * cellH + 0.5, cellW - 1, cellH - 1);
        }
      }
    }
    ctx.restore();

    // P50 / P95 guide lines
    const spans  = nodeSpans.get(selectedNodeId) ?? [];
    const sorted = spans.map(s => s.duration_ms).filter(d => d > 0).sort((a, b) => a - b);
    const guides: Array<[number, string, number]> = [
      [0.50, C.p50, 3],
      [0.95, C.p95, 10],
    ];
    for (const [p, lineColor, minPts] of guides) {
      if (sorted.length < minPts) continue;
      const val = pctile(sorted, p);
      const gy  = (HM_ROWS - 1 - msToHmRow(val)) * cellH + cellH / 2;
      ctx.beginPath(); ctx.setLineDash([4, 3]);
      ctx.moveTo(HM_Y_W, gy); ctx.lineTo(HM_Y_W + plotW, gy);
      ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lineColor; ctx.font = 'bold 8px JetBrains Mono,monospace';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(`p${Math.round(p * 100)} ${fmtDur(val)}`, w - 2, gy - 1);
    }

    // Y-axis labels (left side)
    ctx.save();
    ctx.font = '8px JetBrains Mono,monospace'; ctx.textAlign = 'right';
    for (let r = 1; r < HM_ROWS; r++) {
      const val = HM_EDGES[r];
      if (val === Infinity) continue;
      ctx.fillStyle = 'rgba(148,163,184,0.65)';
      ctx.fillText(fmtDur(val as number), HM_Y_W - 3, (HM_ROWS - r) * cellH + 3);
    }
    ctx.restore();

    // X-axis labels
    ctx.font = '8px JetBrains Mono,monospace';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';  ctx.fillText('older', HM_Y_W + 2, h - 1);
    ctx.textAlign = 'right'; ctx.fillText('now', HM_Y_W + plotW - 2, h - 1);
  }
}
