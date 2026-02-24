// ── Layout engine ─────────────────────────────────────────────────────────────
// Strict grid layout — like a spreadsheet read left-to-right:
//
//   x (column) = topological depth in the span causality DAG
//                root span → column 0 (leftmost)
//                each linked child → one column to the right
//
//   y (row)    = DFS spanning-tree post-order:
//                leaves get sequential row slots
//                a parent with multiple children is centred between them
//
// Positions smoothly lerp to their deterministic grid cell each tick.
// The grid is auto-scaled & centred so all nodes always fit on-screen.

import type { Node, Edge } from '../core/types.ts';

export interface LayoutNode extends Node {
  x: number;
  y: number;
  radius: number;
  depth: number;   // column index (0 = leftmost / root)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HEADER_H   = 92;    // px height of the fixed header / stats bar
const LERP       = 0.10;  // position smoothing factor per frame (~60 fps)
const SIDEBAR_W  = 0;     // no right sidebar in diagram view
const PAD_H      = 50;    // horizontal padding (each side)
const PAD_V      = 40;    // vertical padding above/below grid
const MIN_RADIUS = 12;
const MAX_RADIUS = 38;

// ── Column (depth) computation — BFS shortest-path from any root ─────────────
// Each node's depth = minimum number of hops from any root (zero-in-degree node).
// BFS guarantees that the first time a node is reached its depth is the minimum;
// subsequent longer indirect paths are ignored, so nodes in the same logical
// tier always land in the same column even when dynamic span-derived edges
// create indirect back-paths through deeper nodes.
// Cycles are handled safely: a node is enqueued exactly once (on first visit).

function computeDepths(nodeIds: string[], edges: Edge[]): Map<string, number> {
  const nodeSet  = new Set(nodeIds);
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of nodeIds) {
    outEdges.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    outEdges.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const depths = new Map<string, number>();
  const queue: string[] = [];

  // Seed BFS from all roots (zero in-degree)
  for (const id of nodeIds) {
    if ((inDegree.get(id) ?? 0) === 0) {
      depths.set(id, 0);
      queue.push(id);
    }
  }

  // BFS — each node settled at its minimum (shortest-path) depth; never revisited.
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d   = depths.get(cur)!;
    for (const next of outEdges.get(cur) ?? []) {
      if (!depths.has(next)) {
        depths.set(next, d + 1);
        queue.push(next);
      }
    }
  }

  // Disconnected / cycle-only nodes default to 0
  for (const id of nodeIds) {
    if (!depths.has(id)) depths.set(id, 0);
  }
  return depths;
}

// ── Row computation — DFS post-order spanning tree ────────────────────────────

function computeRowSlots(
  nodeIds: string[],
  edges:   Edge[],
  depths:  Map<string, number>,
): Map<string, number> {
  // Forward-only adjacency
  const children = new Map<string, string[]>();
  for (const id of nodeIds) children.set(id, []);
  for (const e of edges) {
    const sd = depths.get(e.source) ?? 0;
    const td = depths.get(e.target) ?? 0;
    if (td > sd && children.has(e.source)) {
      children.get(e.source)!.push(e.target);
    }
  }

  const slots   = new Map<string, number>();
  const visited = new Set<string>();
  let   nextRow = 0;

  function dfs(id: string): number {
    if (visited.has(id)) return slots.get(id) ?? 0;
    visited.add(id);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      slots.set(id, nextRow++);
      return nextRow - 1;
    }
    const childSlots = kids.map(dfs);
    const mySlot = (Math.min(...childSlots) + Math.max(...childSlots)) / 2;
    slots.set(id, mySlot);
    return mySlot;
  }

  const roots = nodeIds.filter(id => (depths.get(id) ?? 0) === 0);
  for (const r of roots) dfs(r);
  for (const id of nodeIds) {
    if (!visited.has(id)) dfs(id);
  }

  // De-collision: within each depth column, nodes that share a common child
  // end up with identical DFS-derived slots.  Sweep each column in slot order
  // and nudge any overlapping node forward by 1 so no two nodes share a row.
  const byDepth = new Map<number, string[]>();
  for (const id of nodeIds) {
    const d = depths.get(id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }
  for (const [, group] of byDepth) {
    if (group.length < 2) continue;
    group.sort((a, b) => (slots.get(a) ?? 0) - (slots.get(b) ?? 0));
    let cursor = slots.get(group[0]) ?? 0;
    for (let i = 1; i < group.length; i++) {
      const s = slots.get(group[i]) ?? 0;
      cursor = Math.max(s, cursor + 1);
      slots.set(group[i], cursor);
    }
  }

  return slots;
}

// ── Layout class ──────────────────────────────────────────────────────────────

export class Layout {
  nodes: Map<string, LayoutNode> = new Map();

  private width  = 800;
  private height = 600;

  // ── Topology cache ─────────────────────────────────────────────────────────────────────────────
  // BFS depth + DFS row computation is O(n²) and was running 60x/s even when
  // the topology was completely static.  We now re-run it only when the edge set
  // or node set changes.  We use a simple content hash (sorted edge keys joined)
  // rather than reference identity so new merged-edge arrays trigger correctly.
  private lastEdgesHash:   string                  = '';
  private lastNodeCount:   number                  = -1;
  private lastEdgesRef:    Edge[] | null           = null;  // reference fast-path
  private cachedDepths:    Map<string, number>     = new Map();
  private cachedRows:      Map<string, number>     = new Map();
  // ── Convergence tracking ───────────────────────────────────────────────────
  // When all nodes have reached within SETTLE_PX of their targets we stop
  // calling the lerp loop, saving O(n) work per frame.  Resets on topology change.
  private _settled = false;
  /** True once all nodes have converged to their grid targets. */
  get isSettled() { return this._settled; }
  /** Force re-lerp on next tick (called externally after e.g. resize). */
  unsettle() { this._settled = false; }

  resize(w: number, h: number) {
    this.width  = w;
    this.height = h;
  }

  upsert(nodes: Node[]) {
    const existing = new Set(this.nodes.keys());

    for (const n of nodes) {
      if (!this.nodes.has(n.id)) {
        this.nodes.set(n.id, {
          ...n,
          x:      PAD_H,
          y:      HEADER_H + PAD_V,
          radius: MAX_RADIUS,
          depth:  0,
        });
      } else {
        const ln = this.nodes.get(n.id)!;
        ln.label      = n.label;
        ln.span_count = n.span_count;
        ln.category   = n.category;
      }
      existing.delete(n.id);
    }
    for (const id of existing) this.nodes.delete(id);
  }

  /**
   * @param edges        All edges (server topology + client span-derived) — used for row layout.
   * @param depthEdges   Optional subset of edges used exclusively for column-depth computation.
   *                     Pass `serverEdges` here so span-derived shortcuts don't pull tier-N nodes
   *                     into earlier columns (e.g. a direct `api→cache` span edge won't override
   *                     the depth-3 tier position that the topology snapshot established).
   */
  tick(edges: Edge[], depthEdges?: Edge[]) {
    const nodeArr = Array.from(this.nodes.values());
    if (nodeArr.length === 0) return;

    const ids = nodeArr.map(n => n.id);

    // ── Recompute topology only when structure changes ─────────────────────────────
    let topologyChanged = false;
    if (edges !== this.lastEdgesRef || this.nodes.size !== this.lastNodeCount) {
      const edgesHash = edges.map(e => `${e.source}=>${e.target}`).sort().join('|');
      if (edgesHash !== this.lastEdgesHash || this.nodes.size !== this.lastNodeCount) {
        this.lastEdgesHash = edgesHash;
        this.lastNodeCount = this.nodes.size;
        // Depths are computed from depthEdges (server topology) if supplied, so that
        // span-derived shortcuts never collapse same-tier nodes into shallower columns.
        this.cachedDepths  = computeDepths(ids, depthEdges ?? edges);
        this.cachedRows    = computeRowSlots(ids, edges, this.cachedDepths);
        this._settled      = false;  // new topology → restart lerp
        topologyChanged    = true;
      }
      this.lastEdgesRef = edges;
    }

    // ── Skip lerp when fully converged (and nothing changed) ──────────────────
    if (this._settled && !topologyChanged) return;

    const depths = this.cachedDepths;
    const rows   = this.cachedRows;

    // Available canvas area (excluding sidebar and header)
    const availW = this.width  - SIDEBAR_W - PAD_H * 2;
    const availH = this.height - HEADER_H  - PAD_V * 2;

    // Nodes with no incoming visible edges (children of hidden spans or truly isolated nodes)
    // receive depth 0 from BFS, placing them in the leftmost "root" column alongside genuine
    // root spans.  We no longer push them into a separate far-right column.
    const allDepthVals = ids.map(id => depths.get(id) ?? 0);
    const allRowVals   = ids.map(id => rows.get(id)   ?? 0);
    const totalCols    = allDepthVals.length > 0 ? Math.max(0, ...allDepthVals) : 0;
    const totalRows    = allRowVals.length   > 0 ? Math.max(0, ...allRowVals)   : 0;

    // Fit-to-screen gaps: divide available space evenly, no minimum clamp
    const colGap = totalCols === 0
      ? availW * 0.5
      : Math.min(240, availW / totalCols);
    const rowGap = totalRows === 0
      ? availH * 0.5
      : Math.min(110, availH / totalRows);

    // Node radius scales with the tighter gap, clamped to readable range
    const radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS,
      Math.min(colGap * 0.30, rowGap * 0.46)));

    // Centre the grid inside the available area
    const gridW   = totalCols * colGap;
    const gridH   = totalRows * rowGap;
    const originX = PAD_H + Math.max(radius + 4, (availW - gridW) / 2);
    const originY = HEADER_H + PAD_V + Math.max(radius + 4, (availH - gridH) / 2);

    // ── Per-node lerp — track max movement to detect convergence ──────────────
    const SETTLE_PX = 0.5;  // threshold: consider settled when all nodes move < 0.5px
    let maxDelta = 0;

    for (const n of nodeArr) {
      const col = depths.get(n.id) ?? 0;
      const row = rows.get(n.id)   ?? 0;
      n.radius = radius;
      n.depth  = col;
      const tx = originX + col * colGap;
      const ty = originY + row * rowGap;
      const dx = tx - n.x;
      const dy = ty - n.y;
      if (Math.abs(dx) + Math.abs(dy) > maxDelta) maxDelta = Math.abs(dx) + Math.abs(dy);
      n.x += dx * LERP;
      n.y += dy * LERP;
    }

    // Mark as settled and snap nodes to exact targets (avoids sub-pixel drift)
    if (maxDelta < SETTLE_PX) {
      this._settled = true;
      for (const n of nodeArr) {
        const col = depths.get(n.id) ?? 0;
        const row = rows.get(n.id)   ?? 0;
        n.x = originX + col * colGap;
        n.y = originY + row * rowGap;
      }
    }
  }
}

