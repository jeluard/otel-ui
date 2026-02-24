// ── NodeDetailPanel: right-side drawer for a selected diagram node ────────────

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { SpanEvent, Edge }  from '../core/types.ts';
import type { Layout, LayoutNode } from '../canvas/layout.ts';
import { targetColor }           from '../core/colors.ts';
import { pctile, fmtTime, fmtDur } from '../core/utils.ts';
import { computeSelectionHighlight } from '../core/graph.ts';
import { C }                     from '../core/theme.ts';
import { VizPanel }              from '../panels/viz.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NodeDetailPanelHandle {
  notifySpanArrived(nodeId: string, durationMs: number): void;
  onEdgesChanged(): void;
}

interface NodeDetailPanelProps {
  selectedNodeId: string | null;
  nodeSpans: Map<string, SpanEvent[]>;
  getEdges: () => Edge[];
  getLayoutNodes: () => Map<string, LayoutNode>;
  layout: Layout;
  onClose: () => void;
  onNodeSelect: (nodeId: string) => void;
  onSelectionHighlightChange: (
    hl: { nodes: Set<string>; edgeKeys: Set<string> } | null,
  ) => void;
}

const NODE_SPAN_MAX        = 200;
const REFRESH_INTERVAL_MS  = 500;

// ── Breadcrumb helper (pure, testable) ─────────────────────────────────────────

function buildAncestorChain(nodeId: string, edges: Edge[]): string[] {
  const revAdj = new Map<string, string>();
  for (const e of edges) if (!revAdj.has(e.target)) revAdj.set(e.target, e.source);
  const chain: string[] = [];
  let cur = nodeId;
  const visited = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const parent = revAdj.get(cur);
    if (!parent || visited.has(parent)) break;
    visited.add(parent);
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

function shortName(nodeId: string, layoutNodes: Map<string, LayoutNode>): string {
  const node = layoutNodes.get(nodeId);
  if (node?.label) return node.label;
  return nodeId.includes('::') ? nodeId.split('::').pop()! : nodeId;
}

// ── Component ──────────────────────────────────────────────────────────────────

const NodeDetailPanel = forwardRef<NodeDetailPanelHandle, NodeDetailPanelProps>(
  function NodeDetailPanel(
    { selectedNodeId, nodeSpans, getEdges, getLayoutNodes, layout, onClose, onNodeSelect, onSelectionHighlightChange },
    ref,
  ) {
    const [refreshKey, setRefreshKey] = useState(0);
    const vizContainerRef  = useRef<HTMLDivElement>(null);
    const breadcrumbRef    = useRef<HTMLDivElement>(null);
    const vizRef           = useRef<VizPanel | null>(null);
    const prevNodeRef      = useRef<string | null>(null);
    const refreshTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastRefreshRef   = useRef<number>(0);

    // ── Throttled refresh trigger ──────────────────────────────────────────
    const scheduleRefresh = useCallback(() => {
      if (refreshTimerRef.current !== null) return;
      const delay = Math.max(0, REFRESH_INTERVAL_MS - (performance.now() - lastRefreshRef.current));
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        lastRefreshRef.current  = performance.now();
        setRefreshKey(k => k + 1);
      }, delay);
    }, []);

    // ── Initialize VizPanel once ───────────────────────────────────────────
    useEffect(() => {
      const container = vizContainerRef.current;
      if (!container) return;
      const viz = new VizPanel(container);
      vizRef.current = viz;
      return () => {
        // Cleanup the tooltip VizPanel appended to body
        viz.slCanvas.remove();
        viz.hmCanvas.remove();
        const tip = document.getElementById('spk-tip');
        tip?.remove();
      };
    }, []);

    // ── Scroll breadcrumb to show the current node (right end) on node change ──
    useEffect(() => {
      const el = breadcrumbRef.current;
      if (!el) return;
      // Use rAF so the DOM has been laid out with the new content first
      requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
    }, [selectedNodeId]);

    // ── React to selectedNodeId changes ────────────────────────────────────
    useEffect(() => {
      if (selectedNodeId === prevNodeRef.current) return;
      prevNodeRef.current = selectedNodeId;

      if (!selectedNodeId) {
        onSelectionHighlightChange(null);
        return;
      }

      const hl = computeSelectionHighlight(selectedNodeId, getEdges());
      onSelectionHighlightChange(hl);

      const viz = vizRef.current;
      if (viz) {
        const seedDurs = (nodeSpans.get(selectedNodeId) ?? [])
          .map(s => s.duration_ms)
          .filter(d => d > 0)
          .slice(0, 80)
          .reverse();
        viz.seed(seedDurs);
      }
      lastRefreshRef.current = 0; // force immediate refresh
      setRefreshKey(k => k + 1);
    }, [selectedNodeId, nodeSpans, getEdges, onSelectionHighlightChange]);

    // ── rAF loop for viz animation (only when a node is selected) ─────────
    useEffect(() => {
      if (!selectedNodeId) return;
      let rafId: number;
      let lastTime = performance.now();
      const tick = (now: number) => {
        rafId = requestAnimationFrame(tick);
        const dt = Math.min(now - lastTime, 100);
        lastTime = now;
        vizRef.current?.draw(now, dt, selectedNodeId, nodeSpans);
      };
      rafId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafId);
    }, [selectedNodeId, nodeSpans]);

    // ── Imperative handle ──────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      notifySpanArrived(nodeId, durationMs) {
        if (nodeId !== selectedNodeId) return;
        vizRef.current?.pushDuration(durationMs);
        scheduleRefresh();
      },
      onEdgesChanged() {
        if (!selectedNodeId) return;
        const hl = computeSelectionHighlight(selectedNodeId, getEdges());
        onSelectionHighlightChange(hl);
      },
    }), [selectedNodeId, scheduleRefresh, getEdges, onSelectionHighlightChange]);

    // ── Derived render data (computed fresh each render) ──────────────────
    // refreshKey forces a new render when data changes — actual data read
    // directly from mutable maps to avoid copying large arrays.
    const spans   = (selectedNodeId ? nodeSpans.get(selectedNodeId) : null) ?? [];
    const node    = selectedNodeId ? layout.nodes.get(selectedNodeId) : null;
    const col     = node ? targetColor(node.category) : { fill: C.neutral, text: C.subtle };
    const displayName = node?.label
      ?? (selectedNodeId?.includes('::') ? selectedNodeId.split('::').pop()! : selectedNodeId ?? '');

    const durs   = spans.map(s => s.duration_ms).filter(d => d > 0);
    const sorted = [...durs].sort((a, b) => a - b);
    const p50    = sorted.length >= 3  ? pctile(sorted, 0.50) : null;
    const p95    = sorted.length >= 10 ? pctile(sorted, 0.95) : null;
    const maxDur = sorted.length ? sorted[sorted.length - 1] : null;
    const errCnt = spans.filter(s => s.status === 'error').length;
    const errPct = spans.length ? (errCnt / spans.length * 100) : 0;
    const errCol = errPct > 5 ? C.rose : errPct > 0 ? C.amber : C.ok;

    const ancestors  = selectedNodeId ? buildAncestorChain(selectedNodeId, getEdges()) : [];
    const layoutNodes = getLayoutNodes();

    // Suppress linting for refreshKey: it drives re-evaluation of mutable data
    void refreshKey;

    return (
      <div id="node-detail" className={selectedNodeId ? 'nd-open' : undefined}>
        {/* Header */}
        <div id="nd-header">
          <span id="nd-dot" style={{ background: col.fill, boxShadow: `0 0 6px ${col.fill}88` }} />
          <span id="nd-title" title={selectedNodeId ?? ''} style={{ color: col.fill }}>
            {displayName}
          </span>
          <button id="nd-close" onClick={onClose}>✕</button>
        </div>

        {/* Breadcrumb */}
        {ancestors.length > 0 && (
          <div id="nd-breadcrumb" ref={breadcrumbRef}>
            {ancestors.map((id, i) => (
              <React.Fragment key={id}>
                <span
                  className="nd-bc-node"
                  title={id}
                  onClick={() => onNodeSelect(id)}
                >
                  {shortName(id, layoutNodes)}
                </span>
                <span className="nd-bc-sep">›</span>
              </React.Fragment>
            ))}
            <span
              className="nd-bc-current"
              style={{ color: col.fill }}
              title={selectedNodeId ?? ''}
            >
              {selectedNodeId ? shortName(selectedNodeId, layoutNodes) : ''}
            </span>
          </div>
        )}

        <div id="nd-count">
          {spans.length} span{spans.length !== 1 ? 's' : ''} recorded (last {NODE_SPAN_MAX})
        </div>

        {/* Stats cards */}
        <div id="nd-stats">
          <div className="nd-stat-card">
            <div className="nd-stat-label">P50</div>
            <div className="nd-stat-value">{p50 != null ? fmtDur(p50) : '—'}</div>
          </div>
          <div className="nd-stat-card">
            <div className="nd-stat-label">P95</div>
            <div className="nd-stat-value">{p95 != null ? fmtDur(p95) : '—'}</div>
          </div>
          <div className="nd-stat-card">
            <div className="nd-stat-label">Max</div>
            <div className="nd-stat-value">{maxDur != null ? fmtDur(maxDur) : '—'}</div>
          </div>
          <div className="nd-stat-card">
            <div className="nd-stat-label">Errors</div>
            <div className="nd-stat-value" style={{ color: errCol }}>{errPct.toFixed(0)}%</div>
          </div>
        </div>

        {/* Visualisation (sparkline / heatmap) */}
        <div id="nd-viz-header">
          <button className="nd-viz-tab active" data-viz="sparkline">Sparkline</button>
          <button className="nd-viz-tab" data-viz="heatmap">Heatmap</button>
        </div>
        <div ref={vizContainerRef} id="nd-viz-container" />

        {/* Span history table */}
        <table id="nd-span-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Trace</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="nd-tbody">
            {spans.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: C.muted, textAlign: 'center', padding: '20px' }}>
                  No spans yet
                </td>
              </tr>
            ) : (
              spans.map(s => {
                const statusColor = s.status === 'error' ? C.rose : s.status === 'ok' ? C.ok : C.dim;
                return (
                  <tr key={s.span_id}>
                    <td className="nd-time">{fmtTime(s.start_time_unix_nano)}</td>
                    <td className="nd-trace" title={s.trace_id}>{s.trace_id.slice(0, 12)}…</td>
                    <td className="nd-dur">{fmtDur(s.duration_ms)}</td>
                    <td style={{ color: statusColor }}>{s.status || '—'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    );
  },
);

export default NodeDetailPanel;
