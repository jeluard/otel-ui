// ── Renderer: draws nodes, edges and pulse animations onto the main canvas ───

import type { Edge } from '../core/types.ts';
import type { LayoutNode } from './layout.ts';
import { targetColor } from '../core/colors.ts';
import { C } from '../core/theme.ts';

const PI2 = Math.PI * 2;

// ── Internal types ────────────────────────────────────────────────────────────

interface EdgePulse {
  startTime: number;
  duration: number;    // ms; how long the pulse travels the edge
}

interface EdgeActivity {
  flowCount: number;
  lastActive: number;
  hits: number[];        // activation timestamps (trimmed lazily)
  cachedRate: number;    // hits in last 1s — refreshed up to 2×/s
  rateExpiry: number;    // absolute ms when cachedRate next needs refresh
  latencies: number[];   // call-delay samples kept sorted ascending
  cachedP50: number | null; // null = dirty, recompute from latencies[]
  pulses: EdgePulse[];   // traveling highlight pulses (one per span arrival)
}

interface NodeRipple {
  startTime: number;
  category: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Quadratic bezier (x,y) at parameter t */
function bezierXY(
  t: number,
  sx: number, sy: number,
  cpX: number, cpY: number,
  ex: number, ey: number,
): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: mt * mt * sx + 2 * mt * t * cpX + t * t * ex,
    y: mt * mt * sy + 2 * mt * t * cpY + t * t * ey,
  };
}

/** Hex color (#rrggbb) → rgba string */
function hexRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

/**
 * Edge glow colour based on flow rate:
 *   cold  (1–5 /s)  → indigo
 *   warm  (5–15 /s) → cyan
 *   hot   (>15 /s)  → amber
 */
function rateRgb(rate: number): string {
  if (rate > 15) return '245,158,11';   // amber
  if (rate > 5)  return '6,182,212';    // cyan
  return '99,102,241';                  // indigo
}

/** Linear-interpolation percentile over a pre-sorted ascending array. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i  = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export class Renderer {
  private edgeActivity:    Map<string, EdgeActivity>      = new Map();
  private nodeRipples:     Map<string, NodeRipple[]>      = new Map();
  /** rolling hit timestamps per node for rate display */
  private nodeHits:        Map<string, number[]>          = new Map();
  /** cached per-node spans/s rate (avoids filter() every frame per node) */
  private nodeRateCache:   Map<string, { rate: number; expiry: number }> = new Map();

  /** Cached column-guide entries; invalidated when topology changes. */
  private cachedGuides: Array<{ depth: number; cx: number }> = [];
  private guideTopoKey = '';  // last node-depth hash used to build cachedGuides

  /** Call whenever nodes are added/removed or edge topology changes so the
   *  column-guide cache is recomputed on the next drawColumnGuides call. */
  invalidateGuides() { this.guideTopoKey = ''; }

  /**
   * Returns true if any transient animations are still in-flight —
   * edge pulses, node ripples, or the active-node glow.
   * Used by the frame loop to decide whether to run at full 60fps or throttle
   * the diagram canvas to ~15fps when everything is idle.
   */
  hasActiveAnimations(now: number): boolean {
    if (this.nodeRipples.size > 0) return true;
    for (const ea of this.edgeActivity.values()) {
      if (ea.pulses.length > 0 && (now - ea.pulses[ea.pulses.length - 1].startTime) < ea.pulses[ea.pulses.length - 1].duration + 600) return true;
    }
    return false;
  }

  // ── Public mutators ────────────────────────────────────────────────────────

  /** Called whenever a span travels along source→target.
   * pulseDurationMs controls how long the traveling highlight takes to cross the edge.
   */
  activateEdge(source: string, target: string, time: number, pulseDurationMs: number = 600) {
    const key      = `${source}=>${target}`;
    const existing = this.edgeActivity.get(key);
    const hits     = existing?.hits ?? [];
    hits.push(time);
    // Lazy trim: only when buffer is large (avoids new filtered array every call)
    if (hits.length > 500) {
      const cutoff = time - 5000;
      let i = 0;
      while (i < hits.length && hits[i] < cutoff) i++;
      if (i > 0) hits.splice(0, i);
    }
    const cachedRate = hits.filter(t => t > time - 1000).length;
    // Clamp pulse duration; prune stale pulses, then add the new one
    const duration   = Math.min(2000, Math.max(100, pulseDurationMs));
    const prevPulses = (existing?.pulses ?? []).filter(p => (time - p.startTime) < p.duration + 600);
    prevPulses.push({ startTime: time, duration });
    this.edgeActivity.set(key, {
      flowCount:  (existing?.flowCount ?? 0) + 1,
      lastActive: time,
      hits,
      cachedRate,
      rateExpiry: time + 500,
      latencies:  existing?.latencies ?? [],
      cachedP50:  existing?.cachedP50 ?? null,
      pulses:     prevPulses,
    });
  }

  /** Record a call-latency sample (ms) on an edge. Sanity-filtered to 0–60 s. */
  addEdgeLatency(source: string, target: string, latencyMs: number) {
    if (latencyMs < 0 || latencyMs > 60_000) return;
    const key = `${source}=>${target}`;
    const act = this.edgeActivity.get(key);
    if (!act) return;
    // Binary-search insert keeps latencies[] sorted so no spread+sort at draw time
    const arr = act.latencies;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < latencyMs) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, latencyMs);
    if (arr.length > 100) arr.shift();
    act.cachedP50 = null; // mark dirty
  }

  /** Called when a span arrives at a node — triggers a ripple ring and tracks rate/names. */
  activateNode(nodeId: string, category: string, time: number, spanName?: string) {
    // Ripple ring
    const list = this.nodeRipples.get(nodeId) ?? [];
    list.push({ startTime: time, category });
    if (list.length > 4) list.splice(0, list.length - 4);
    this.nodeRipples.set(nodeId, list);

    // Per-node hit rate — lazy trim to avoid filtered-array allocation on every call
    const hits = this.nodeHits.get(nodeId) ?? [];
    hits.push(time);
    if (hits.length > 500) {
      const cutoff = time - 5000;
      let i = 0;
      while (i < hits.length && hits[i] < cutoff) i++;
      if (i > 0) hits.splice(0, i);
    }
    this.nodeHits.set(nodeId, hits);

  }

  // ── Draw calls ─────────────────────────────────────────────────────────────

  drawEdges(
    ctx: CanvasRenderingContext2D,
    edges: Edge[],
    nodes: Map<string, LayoutNode>,
    time: number,
    highlightEdges?: Set<string> | null,
  ) {
    const hasHL = highlightEdges != null && highlightEdges.size > 0;
    for (const edge of edges) {
      const src = nodes.get(edge.source);
      const tgt = nodes.get(edge.target);
      if (!src || !tgt) continue;
      const key = `${edge.source}=>${edge.target}`;
      const dimmed     = hasHL && !highlightEdges!.has(key);
      const emphasized = hasHL &&  highlightEdges!.has(key);
      this._drawEdge(ctx, edge, src, tgt, time, dimmed, emphasized);
    }
  }

  /** Draw faint depth-column guide lines behind everything else.
   *  Guide positions are rebuilt only when the depth/node set changes
   *  (keyed on a lightweight hash), avoiding O(n) map allocations every frame. */
  drawColumnGuides(
    ctx: CanvasRenderingContext2D,
    nodes: Map<string, LayoutNode>,
    canvasH: number,
    headerH: number,
  ) {
    // Lightweight topology key: sorted "depth:id" pairs.
    // Only recompute when nodes or their depth column changes.
    let topoKey = '';
    for (const n of nodes.values()) topoKey += `${n.depth}:${n.id}|`;

    if (topoKey !== this.guideTopoKey) {
      this.guideTopoKey = topoKey;
      const byDepth = new Map<number, number[]>();  // depth → x values
      for (const n of nodes.values()) {
        const xs = byDepth.get(n.depth) ?? [];
        xs.push(n.x);
        byDepth.set(n.depth, xs);
      }
      this.cachedGuides = [];
      for (const [depth, xs] of byDepth) {
        this.cachedGuides.push({ depth, cx: xs.reduce((s, x) => s + x, 0) / xs.length });
      }
    }

    if (this.cachedGuides.length < 2) return;  // nothing useful to draw

    const DEPTH_LABELS = ['root', 'depth 1', 'depth 2', 'depth 3', 'depth 4',
                          'depth 5', 'depth 6', 'depth 7', 'depth 8', 'depth 9'];

    ctx.save();
    ctx.font         = '500 9px "JetBrains Mono", monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    for (const { depth, cx } of this.cachedGuides) {
      ctx.beginPath();
      ctx.moveTo(cx, headerH + 8);
      ctx.lineTo(cx, canvasH - 8);
      ctx.strokeStyle = C.colGuideStroke;
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.colGuideFill;
      ctx.fillText(DEPTH_LABELS[depth] ?? `depth ${depth}`, cx, headerH + 10);
    }
    ctx.restore();
  }

  drawNodes(
    ctx: CanvasRenderingContext2D,
    nodes: Map<string, LayoutNode>,
    hoveredId: string | null,
    activeExpiry: Map<string, number>,
    time: number,
    highlightNodes?: Set<string> | null,
    selectedId?: string | null,
  ) {
    const hasHL = highlightNodes != null && highlightNodes.size > 0;

    // ── Ripple rings (behind nodes) ─────────────────────────────────────────
    // When selection is active, draw dimmed ripples in one batched composite pass
    // (one ctx.filter application for the whole group) then draw highlighted ripples
    // at full opacity.  This avoids N separate GPU compositing passes.
    if (hasHL) {
      ctx.save();
      ctx.filter = 'opacity(0.12)';
      for (const [nodeId, ripples] of this.nodeRipples) {
        if (highlightNodes!.has(nodeId)) continue;
        const node = nodes.get(nodeId);
        if (!node) continue;
        const alive: NodeRipple[] = [];
        for (const ripple of ripples) {
          const age = time - ripple.startTime;
          if (age < 900) { this._drawRipple(ctx, node, ripple.category, age); alive.push(ripple); }
        }
        this.nodeRipples.set(nodeId, alive);
      }
      ctx.restore();
      for (const [nodeId, ripples] of this.nodeRipples) {
        if (!highlightNodes!.has(nodeId)) continue;
        const node = nodes.get(nodeId);
        if (!node) continue;
        const alive: NodeRipple[] = [];
        for (const ripple of ripples) {
          const age = time - ripple.startTime;
          if (age < 900) { this._drawRipple(ctx, node, ripple.category, age); alive.push(ripple); }
        }
        this.nodeRipples.set(nodeId, alive);
      }
    } else {
      for (const [nodeId, ripples] of this.nodeRipples) {
        const node = nodes.get(nodeId);
        if (!node) continue;
        const alive: NodeRipple[] = [];
        for (const ripple of ripples) {
          const age = time - ripple.startTime;
          if (age < 900) { this._drawRipple(ctx, node, ripple.category, age); alive.push(ripple); }
        }
        this.nodeRipples.set(nodeId, alive);
      }
    }

    // ── Nodes ────────────────────────────────────────────────────────────────
    // KEY PERF: batch all dimmed nodes under ONE ctx.filter composite pass.
    // Previously each node called ctx.save/filter/restore individually → N GPU
    // compositing passes per frame.  Now it's at most 2 passes total.
    if (hasHL) {
      ctx.save();
      ctx.filter = 'opacity(0.12)';
      for (const node of nodes.values()) {
        if (!highlightNodes!.has(node.id)) {
          this._drawNode(ctx, node, false, false, time, false, false);
        }
      }
      ctx.restore();
      for (const node of nodes.values()) {
        if (!highlightNodes!.has(node.id)) continue;
        this._drawNode(ctx, node, hoveredId === node.id, (activeExpiry.get(node.id) ?? 0) > time, time, false, node.id === selectedId);
      }
    } else {
      for (const node of nodes.values()) {
        this._drawNode(ctx, node, hoveredId === node.id, (activeExpiry.get(node.id) ?? 0) > time, time, false, node.id === selectedId);
      }
    }
  }



  hitTest(x: number, y: number, nodes: Map<string, LayoutNode>): string | null {
    for (const node of nodes.values()) {
      const dx = node.x - x;
      const dy = node.y - y;
      if (dx * dx + dy * dy <= node.radius * node.radius * 1.2) return node.id;
    }
    return null;
  }

  // ── Private drawing helpers ────────────────────────────────────────────────

  private _drawEdge(
    ctx: CanvasRenderingContext2D,
    edge: Edge,
    src: LayoutNode,
    tgt: LayoutNode,
    time: number,
    dimmed   = false,
    emphasized = false,
  ) {
    const key      = `${edge.source}=>${edge.target}`;
    const activity = this.edgeActivity.get(key);
    const age      = activity ? (time - activity.lastActive) / 2000 : 1;
    // Cached rate (stale ≤500ms); refresh lazily to avoid filter() every frame
    let rate = 0;
    if (activity) {
      if (time < activity.rateExpiry) {
        rate = activity.cachedRate;
      } else {
        rate = activity.hits.filter(t => t > time - 1000).length;
        activity.cachedRate = rate;
        activity.rateExpiry = time + 500;
      }
    }

    const baseAlpha = Math.max(0.18, 0.6 - age * 0.42);
    // Edge width scales with throughput (1 px idle → 3.5 px at high rate)
    const lineWidth = 1 + Math.min(2.5, rate * 0.12);

    // Apply dimming / emphasis for selection highlight
    const alphaScale  = dimmed ? 0.10 : emphasized ? 1.4 : 1.0;
    const widthScale  = emphasized ? 1.8 : 1.0;
    const edgeAlpha   = Math.min(1, baseAlpha * alphaScale);
    const edgeWidth   = lineWidth * widthScale;

    // Direction and edge endpoints at node borders
    const dx  = tgt.x - src.x;
    const dy  = tgt.y - src.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const nx = dx / len;
    const ny = dy / len;

    const sx = src.x + nx * src.radius;
    const sy = src.y + ny * src.radius;
    const ex = tgt.x - nx * tgt.radius;
    const ey = tgt.y - ny * tgt.radius;

    // Bezier control point: arc perpendicularly (left-hand normal = -ny, nx)
    const arcAmount = Math.min(60, len * 0.2);
    const cpX = (sx + ex) / 2 + (-ny) * arcAmount;
    const cpY = (sy + ey) / 2 +   nx  * arcAmount;

    ctx.save();

    // Base dashed line
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cpX, cpY, ex, ey);
    ctx.strokeStyle = `rgba(${C.subtleRgb},${edgeAlpha})`;
    ctx.lineWidth   = edgeWidth;
    ctx.setLineDash([4, 8]);
    ctx.lineDashOffset = -(time * 0.02) % 12;
    ctx.stroke();
    ctx.setLineDash([]);

    // Activity glow — colour shifts cold→warm→hot with rate
    if (age < 1) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cpX, cpY, ex, ey);
      ctx.strokeStyle = `rgba(${rateRgb(rate)},${(1 - age) * 0.5 * alphaScale})`;
      ctx.lineWidth   = edgeWidth + 2.5;
      ctx.stroke();
    }

    // ── Traveling highlight pulses (cube-flow) ────────────────────────────────
    if (activity?.pulses && activity.pulses.length > 0) {
      const srcCol = targetColor(src.category);
      for (const pulse of activity.pulses) {
        const elapsed = time - pulse.startTime;
        if (elapsed < 0 || elapsed > pulse.duration + 400) continue;
        const tPos    = Math.min(1, elapsed / pulse.duration);
        const pAlpha  = elapsed < pulse.duration
          ? Math.min(1, tPos * 10)                                    // fade in (first 10%)
          : Math.max(0, 1 - (elapsed - pulse.duration) / 400);       // fade out after arrival
        if (pAlpha <= 0) continue;
        // Draw a 4-cube trail along the bezier (ti=0 is the leader)
        for (let ti = 3; ti >= 0; ti--) {
          const trailT  = Math.max(0, tPos - ti * 0.04);
          const mt2     = 1 - trailT;
          const tpx     = mt2 * mt2 * sx + 2 * mt2 * trailT * cpX + trailT * trailT * ex;
          const tpy     = mt2 * mt2 * sy + 2 * mt2 * trailT * cpY + trailT * trailT * ey;
          // Tangent for rotation
          const tPrev   = Math.max(0, trailT - 0.02);
          const mtp     = 1 - tPrev;
          const ppx     = mtp * mtp * sx + 2 * mtp * tPrev * cpX + tPrev * tPrev * ex;
          const ppy     = mtp * mtp * sy + 2 * mtp * tPrev * cpY + tPrev * tPrev * ey;
          const ang     = Math.atan2(tpy - ppy, tpx - ppx);
          const isHead  = ti === 0;
          const size    = isHead ? 5 : 3;
          const cubeA   = pAlpha * (1 - ti / 4) * (isHead ? 0.95 : 0.35);
          ctx.save();
          ctx.translate(tpx, tpy);
          ctx.rotate(ang + Math.PI / 4);   // 45° → diamond shape
          ctx.fillStyle   = srcCol.fill;
          ctx.shadowColor = srcCol.fill;
          ctx.shadowBlur  = isHead ? 9 : 0;
          ctx.globalAlpha = cubeA;
          ctx.fillRect(-size / 2, -size / 2, size, size);
          ctx.shadowBlur  = 0;
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }
    }

    // Arrowhead — tangent at t=1 of a quadratic bezier is the cp→end direction
    {
      const arrowAngle = Math.atan2(ey - cpY, ex - cpX);
      const aSize = 5.5;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - aSize * Math.cos(arrowAngle - 0.42), ey - aSize * Math.sin(arrowAngle - 0.42));
      ctx.lineTo(ex - aSize * Math.cos(arrowAngle + 0.42), ey - aSize * Math.sin(arrowAngle + 0.42));
      ctx.closePath();
      ctx.fillStyle = `rgba(${C.subtleRgb},${Math.min(1, edgeAlpha * 2.5)})`;
      ctx.fill();
    }

    // Travelling flow-rate + call-latency labels at the midpoint of the curve
    {
      const mid        = bezierXY(0.5, sx, sy, cpX, cpY, ex, ey);
      // Offset 14 px along the left-hand normal of the direct vector
      const lx         = mid.x + (-ny) * 14;
      const ly         = mid.y +   nx  * 14;
      const labelAlpha = Math.min(1, Math.max(0.35, 1 - age * 0.6));
      const rgb        = rateRgb(rate);

      // P50 latency: recompute only when dirty (latencies[] is kept sorted)
      let p50Lat: number | null = null;
      if (activity && activity.latencies.length >= 3) {
        if (activity.cachedP50 === null) activity.cachedP50 = pct(activity.latencies, 0.5);
        p50Lat = activity.cachedP50;
      }

      ctx.font         = '500 9px "JetBrains Mono", monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';

      // Rate pill
      if (rate > 0) {
        const label = `${rate}/s`;
        const tw    = ctx.measureText(label).width;
        const pw    = tw + 8;
        const ph    = 12;
        ctx.fillStyle   = `rgba(${C.labelBgRgb},${labelAlpha * 0.9})`;
        ctx.fillRect(lx - pw / 2, ly - ph / 2, pw, ph);
        ctx.strokeStyle = `rgba(${rgb},${labelAlpha * 0.6})`;
        ctx.lineWidth   = 0.5;
        ctx.strokeRect(lx - pw / 2, ly - ph / 2, pw, ph);
        ctx.fillStyle   = `rgba(${rgb},${labelAlpha})`;
        ctx.fillText(label, lx, ly);
      }

      // Latency pill (P50 call-delay, amber)
      if (p50Lat != null) {
        const latLabel = p50Lat < 1
          ? `~${(p50Lat * 1000).toFixed(0)}\u00b5s`
          : p50Lat < 1000
            ? `~${p50Lat.toFixed(1)}ms`
            : `~${(p50Lat / 1000).toFixed(2)}s`;
        const latY  = ly + (rate > 0 ? 14 : 0);
        const latA  = Math.min(1, Math.max(0.3, labelAlpha));
        const tw2   = ctx.measureText(latLabel).width;
        const pw2   = tw2 + 8;
        const ph2   = 12;
        ctx.fillStyle   = `rgba(${C.labelBgRgb},${latA * 0.88})`;
        ctx.fillRect(lx - pw2 / 2, latY - ph2 / 2, pw2, ph2);
        ctx.strokeStyle = `rgba(${C.p50Rgb},${latA * 0.5})`;
        ctx.lineWidth   = 0.5;
        ctx.strokeRect(lx - pw2 / 2, latY - ph2 / 2, pw2, ph2);
        ctx.fillStyle   = `rgba(${C.p50Rgb},${latA})`;
        ctx.fillText(latLabel, lx, latY);
      }
    }

    ctx.restore();
  }

  private _drawRipple(
    ctx: CanvasRenderingContext2D,
    node: LayoutNode,
    category: string,
    age: number,        // 0 … 900 ms
  ) {
    const col      = targetColor(category);
    const progress = age / 900;
    const r        = node.radius * (1 + progress * 1.8);
    const alpha    = (1 - progress) * 0.55;

    ctx.save();
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, PI2);
    ctx.strokeStyle = hexRgba(col.fill, alpha);
    ctx.lineWidth   = 1.5 * (1 - progress * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  private _drawNode(
    ctx: CanvasRenderingContext2D,
    node: LayoutNode,
    hovered: boolean,
    active: boolean,
    time: number,
    _dimmed  = false,   // dimming now handled externally via batched ctx.filter
    selected = false,
  ) {
    const { x, y, radius } = node;
    const col = targetColor(node.category);
    const r   = radius;

    ctx.save();
    // NOTE: ctx.filter for dimming is applied by the caller as a batch operation
    // over all dimmed nodes at once — do NOT set it per-node here.

    // Outer glow
    if (active) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.004);
      const gGlow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.5);
      gGlow.addColorStop(0, col.glow.replace('0.4', String(0.4 + pulse * 0.2)));
      gGlow.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(x, y, r * 2.5, 0, PI2);
      ctx.fillStyle = gGlow;
      ctx.fill();
    } else if (hovered) {
      const gGlow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2);
      gGlow.addColorStop(0, col.glow);
      gGlow.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(x, y, r * 2, 0, PI2);
      ctx.fillStyle = gGlow;
      ctx.fill();
    }

    // Background fill (dark glass)
    const bgGrad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    bgGrad.addColorStop(0, C.nodeBg0);
    bgGrad.addColorStop(1, C.nodeBg1);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, PI2);
    ctx.fillStyle = bgGrad;
    ctx.fill();

    // Coloured ring
    ctx.beginPath();
    ctx.arc(x, y, r, 0, PI2);
    ctx.strokeStyle = col.fill;
    ctx.lineWidth   = active ? 2.5 : hovered ? 2 : 1.5;
    ctx.globalAlpha = active ? 1   : hovered ? 0.9 : 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Inner accent dot
    ctx.beginPath();
    ctx.arc(x, y - r * 0.45, 4, 0, PI2);
    ctx.fillStyle   = col.fill;
    ctx.globalAlpha = 0.7;
    ctx.fill();
    ctx.globalAlpha = 1;

    // ── Span name label above the node ────────────────────────────────────────
    {
      const maxChars = 22;
      const display  = node.label.length > maxChars
        ? node.label.slice(0, maxChars - 1) + '\u2026'
        : node.label;
      ctx.font         = '500 10px Inter, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle    = (active || hovered) ? col.text : `rgba(${C.subtleRgb},0.78)`;
      ctx.fillText(display, x, y - r - 5);
    }

    // ── Below-node indicators: spans/s rate ──────────────────────────────────
    // Cached rate (stale ≤400ms) to avoid filter() every frame per node
    let rate = 0;
    const rateC = this.nodeRateCache.get(node.id);
    if (rateC && time < rateC.expiry) {
      rate = rateC.rate;
    } else {
      const nhits = this.nodeHits.get(node.id) ?? [];
      rate = nhits.filter(t => t > time - 1000).length;
      this.nodeRateCache.set(node.id, { rate, expiry: time + 400 });
    }
    const belowY  = y + r + 14;
    ctx.textAlign = 'center';

    // Aggregated spans/s rate
    ctx.font      = '600 10px "JetBrains Mono", monospace';
    ctx.fillStyle = rate > 0 ? C.dotActive : C.dotInactive;
    ctx.fillText(`${rate}/s`, x, belowY);

    // Span count badge (bottom-right corner)
    if (node.span_count > 0) {
      const bx = x + r * 0.65;
      const by = y + r * 0.65;
      ctx.beginPath();
      ctx.arc(bx, by, 10, 0, PI2);
      ctx.fillStyle   = col.fill;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle   = C.onFill;
      ctx.font = 'bold 8px Inter, sans-serif';
      ctx.fillText(node.span_count > 999 ? '999+' : String(node.span_count), bx, by + 0.5);
    }

    // ── Selection indicator: dashed white ring around the selected node ──────
    if (selected) {
      ctx.filter      = 'none';       // ensure full brightness regardless of dimming
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, PI2);
      ctx.strokeStyle = C.selRing;
      ctx.lineWidth   = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}
