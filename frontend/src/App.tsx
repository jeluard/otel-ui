// ── App: root component and orchestration layer ───────────────────────────────

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';

import { Layout }          from './canvas/layout.ts';
import { Renderer }        from './canvas/renderer.ts';
import { Camera }          from './canvas/camera.ts';
import { targetColor }     from './core/colors.ts';
import { edgeWouldCreateCycle } from './core/graph.ts';
import { loadDefaultFilters, hiddenRules, isSpanHidden, getHiddenInstances } from './panels/hide-rules.ts';
import { startDemo, setDemoConfig, DEFAULT_DEMO_CONFIG } from './core/demo.ts';
import type { DemoScenario, DemoConfig } from './core/demo.ts';
import { useWebSocket }    from './hooks/useWebSocket.ts';
import { useHistoryPlayback } from './hooks/useHistoryPlayback.ts';
import type { SpanEvent, WsMessage, Edge, Node, TraceComplete } from './core/types.ts';

import Header          from './components/Header.tsx';
import WelcomeScreen   from './components/WelcomeScreen.tsx';
import StatisticsView  from './components/StatisticsView.tsx';
import DiagramView     from './components/DiagramView.tsx';
import SpansView       from './components/SpansView.tsx';
import TracesPanel     from './components/TracesPanel.tsx';
import NodeDetailPanel from './components/NodeDetailPanel.tsx';
import HideRulesDialog from './components/HideRulesDialog.tsx';

import type { DiagramViewHandle }     from './components/DiagramView.tsx';
import type { SpansViewHandle }       from './components/SpansView.tsx';
import type { TracesPanelHandle }     from './components/TracesPanel.tsx';
import type { NodeDetailPanelHandle } from './components/NodeDetailPanel.tsx';
import type { LayoutNode }            from './canvas/layout.ts';

// ── Injected at build time ────────────────────────────────────────────────────
declare const __BRIDGE_IMAGE__: string;

// ── Exported types ─────────────────────────────────────────────────────────────

export type TabId = 'diagram' | 'spans' | 'traces' | 'statistics';

export interface SharedState {
  layout:         Layout;
  renderer:       Renderer;
  camera:         Camera;
  serverEdges:    Edge[];
  clientEdgeMap:  Map<string, Edge>;
  edges:          Edge[];
  spanQueue:      SpanEvent[];
  nodeSpans:      Map<string, SpanEvent[]>;
  inFlightSpans:  Map<string, SpanEvent[]>;
  spanVisibleNode: Map<string, string | null>;
  activeExpiry:   Map<string, number>;
  spansThisSecond:  number;
  tracesThisSecond: number;
  spsSmoothed:      number;
  tpsSmoothed:      number;
  lastRateUpdate:   number;
  traceHL:    { nodes: Set<string>; edgeKeys: Set<string> } | null;
  selectionHL: { nodes: Set<string>; edgeKeys: Set<string> } | null;
}

// ── WS URL ────────────────────────────────────────────────────────────────────

const WS_URL = (() => {
  const hashWs = new URLSearchParams(window.location.hash.slice(1)).get('ws');
  if (hashWs) return hashWs;
  const { hostname, port, protocol } = window.location;
  const proto = protocol === 'https:' ? 'wss:' : 'ws:';
  if (port === '8080') return `${proto}//${hostname}:8081/ws`;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    return `${proto}//${hostname}${port ? ':' + port : ''}/ws`;
  return 'ws://localhost:8080/ws';
})();

const NODE_SPAN_MAX    = 200;
/** Keep traces within this rolling window for the Statistics view (ms). */
const STATS_WINDOW_MS  = 10 * 60 * 1000; // 10 minutes

// ── Component ──────────────────────────────────────────────────────────────────

export default function App() {
  // ── React state ────────────────────────────────────────────────────────────
  const [wsConnected,    setWsConnected]    = useState(false);
  const [demoMode,       setDemoMode]       = useState(false);
  const [demoScenario,   setDemoScenario]   = useState<DemoScenario>('standard');
  const [demoConfig,     setDemoConfigState] = useState<DemoConfig>({ ...DEFAULT_DEMO_CONFIG });
  const [welcomeVisible, setWelcomeVisible] = useState(true);
  const [activeTab,      setActiveTab]      = useState<TabId>('diagram');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hasData,        setHasData]        = useState(false);
  const [sps,              setSps]              = useState(0);
  const [tps,              setTps]              = useState(0);
  const [spansFlashing,    setSpansFlashing]    = useState(false);
  const [showHideRules,    setShowHideRules]    = useState(false);
  const [completedTraces,  setCompletedTraces]  = useState<TraceComplete[]>([]);
  const [hasReceivedTraces, setHasReceivedTraces] = useState(false);
  const completedTracesRef = useRef<TraceComplete[]>([]);
  useEffect(() => { completedTracesRef.current = completedTraces; }, [completedTraces]);


  const knownInstances = useMemo(() => {
    const seen = new Set<string>();
    for (const t of completedTraces)
      for (const s of t.spans) { if (s.instance_id) seen.add(s.instance_id); }
    return [...seen].sort();
  }, [completedTraces]);

  // ── History playback ───────────────────────────────────────────────────────
  const historyPlayback  = useHistoryPlayback(demoMode);
  const historyEnabledRef = useRef(false);
  /** Last cursor position processed by the history frame loop. */
  const histLastCursorRef = useRef(0);
  useEffect(() => {
    historyEnabledRef.current = historyPlayback.historyEnabled;
    if (!historyPlayback.historyEnabled) {
      // Exiting history: clear transient state. Topology will be rebuilt from live spans_batch messages.
      histLastCursorRef.current = 0;
      setCompletedTraces([]);
      const st = sharedRef.current;
      st.renderer.clearActivity();
      st.layout.clear();
      st.serverEdges     = [];
      st.clientEdgeMap   = new Map();
      st.edges           = [];
      st.spanQueue       = [];
      st.nodeSpans       = new Map();
      st.inFlightSpans   = new Map();
      st.spanVisibleNode = new Map();
      st.activeExpiry    = new Map();
      // Topology will be rebuilt from live spans_batch messages.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyPlayback.historyEnabled]);

  // ── Mutable shared state (NOT React state — avoids re-renders) ─────────────
  const sharedRef = useRef<SharedState>({
    layout:           new Layout(),
    renderer:         new Renderer(),
    camera:           new Camera(),
    serverEdges:      [],
    clientEdgeMap:    new Map(),
    edges:            [],
    spanQueue:        [],
    nodeSpans:        new Map(),
    inFlightSpans:    new Map(),
    spanVisibleNode:  new Map(),
    activeExpiry:     new Map(),
    spansThisSecond:  0,
    tracesThisSecond: 0,
    spsSmoothed:      0,
    tpsSmoothed:      0,
    lastRateUpdate:   performance.now(),
    traceHL:          null,
    selectionHL:      null,
  });

  // ── Stable refs to avoid stale closures ────────────────────────────────────
  const activeTabRef      = useRef<TabId>('diagram');
  const spanFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoCleanupRef    = useRef<(() => void) | null>(null);
  const demoModeRef       = useRef(false);
  const wsConnectedRef    = useRef(false);
  /** Persistent span-id → node-id index for cross-batch parent resolution. */
  const spanIdToNodeRef   = useRef<Map<string, string>>(new Map());
  /** Persistent span-id → start time (ns) for edge latency computation. */
  const spanStartTimeRef  = useRef<Map<string, number>>(new Map());
  useEffect(() => { activeTabRef.current = activeTab; },     [activeTab]);
  useEffect(() => { demoModeRef.current  = demoMode; },      [demoMode]);

  // ── Component refs ──────────────────────────────────────────────────────────
  const diagramViewRef  = useRef<DiagramViewHandle>(null);
  const spansViewRef    = useRef<SpansViewHandle>(null);
  const tracesPanelRef  = useRef<TracesPanelHandle>(null);
  const nodeDetailRef   = useRef<NodeDetailPanelHandle>(null);

  // ── Load default filters (async, best effort before WS starts) ─────────────
  useEffect(() => {
    loadDefaultFilters().catch(console.warn);
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const rebuildMergedEdges = useCallback(() => {
    const st = sharedRef.current;
    const merged = new Map<string, Edge>();
    for (const e of st.serverEdges)          merged.set(`${e.source}=>${e.target}`, e);
    for (const [key, e] of st.clientEdgeMap) if (!merged.has(key)) merged.set(key, e);
    st.edges = Array.from(merged.values());
    nodeDetailRef.current?.onEdgesChanged();
    st.renderer.invalidateGuides();
  }, []);

  const recordNodeSpan = useCallback((nodeId: string, span: SpanEvent) => {
    const st  = sharedRef.current;
    const arr = st.nodeSpans.get(nodeId) ?? [];
    arr.unshift(span);
    if (arr.length > NODE_SPAN_MAX) arr.length = NODE_SPAN_MAX;
    st.nodeSpans.set(nodeId, arr);
  }, []);

  const flashSpanDot = useCallback(() => {
    setSpansFlashing(true);
    if (spanFlashTimerRef.current) clearTimeout(spanFlashTimerRef.current);
    spanFlashTimerRef.current = setTimeout(() => {
      setSpansFlashing(false);
      spanFlashTimerRef.current = null;
    }, 120);
  }, []);

  const lookupSpan = useCallback((spanId: string): SpanEvent | undefined => {
    // Completed traces carry full attributes — check these first.
    const fromCompleted = tracesPanelRef.current?.lookupSpan(spanId);
    if (fromCompleted) return fromCompleted;
    const st = sharedRef.current;
    for (const spans of st.inFlightSpans.values()) {
      const found = spans.find(s => s.span_id === spanId);
      if (found) return found;
    }
    for (const spans of st.nodeSpans.values()) {
      const found = spans.find(s => s.span_id === spanId);
      if (found) return found;
    }
    return undefined;
  }, []);

  // ── Process a single span ───────────────────────────────────────────────────
  const processSpan = useCallback((span: SpanEvent, frameTime: number) => {
    const to_node = span.target;
    const st = sharedRef.current;

    // Populate indexes for descendant spans in this trace
    spanIdToNodeRef.current.set(span.span_id, to_node);
    spanStartTimeRef.current.set(span.span_id, span.start_time_unix_nano);

    const effectiveFrom: string | null = span.parent_span_id
      ? (st.spanVisibleNode.get(span.parent_span_id) ?? null)
      : null;

    if (hiddenRules.length && isSpanHidden(span)) {
      st.spanVisibleNode.set(span.span_id, effectiveFrom);
      return;
    }

    const hiddenInst = getHiddenInstances();
    if (hiddenInst.size > 0 && span.instance_id && hiddenInst.has(span.instance_id)) {
      st.spanVisibleNode.set(span.span_id, effectiveFrom);
      return;
    }

    st.spanVisibleNode.set(span.span_id, to_node);

    // Dynamic edge learning
    const fromNode = span.parent_span_id
      ? (spanIdToNodeRef.current.get(span.parent_span_id) ?? null)
      : null;
    const layoutFrom = effectiveFrom
      ?? (fromNode && fromNode !== to_node ? fromNode : null);
    if (layoutFrom && layoutFrom !== to_node) {
      const ek = `${layoutFrom}=>${to_node}`;
      const serverHas = st.serverEdges.some(e => e.source === layoutFrom && e.target === to_node);
      if (!serverHas && !st.clientEdgeMap.has(ek) && !edgeWouldCreateCycle(layoutFrom, to_node, st.edges)) {
        st.clientEdgeMap.set(ek, { source: layoutFrom, target: to_node, flow_count: 0 });
        rebuildMergedEdges();
      }
    }

    st.spansThisSecond++;
    flashSpanDot();

    const existing = st.inFlightSpans.get(span.trace_id);
    if (existing) existing.push(span); else st.inFlightSpans.set(span.trace_id, [span]);
    tracesPanelRef.current?.notifySpanInFlight(span.trace_id);

    spansViewRef.current?.add(span, activeTabRef.current === 'spans');
    recordNodeSpan(to_node, span);
    nodeDetailRef.current?.notifySpanArrived(to_node, span.duration_ms);

    targetColor(span.target);
    const cat = st.layout.nodes.get(to_node)?.category ?? 'other';
    st.renderer.activateNode(to_node, cat, frameTime, span.name);
    st.activeExpiry.set(to_node, frameTime + 600);

    // Propagate activity (and span data) up the target path hierarchy.
    // e.g. amaru::chain::validation also activates amaru::chain and amaru.
    const parts = to_node.split('::');
    for (let i = 1; i < parts.length; i++) {
      const ancestorId = parts.slice(0, i).join('::');
      const aCat = st.layout.nodes.get(ancestorId)?.category ?? cat;
      st.renderer.activateNode(ancestorId, aCat, frameTime, span.name);
      st.activeExpiry.set(ancestorId, frameTime + 600);
      recordNodeSpan(ancestorId, span);
      nodeDetailRef.current?.notifySpanArrived(ancestorId, span.duration_ms);
      // Activate the ancestry edge too
      const childId = parts.slice(0, i + 1).join('::');
      st.renderer.activateEdge(ancestorId, childId, frameTime, Math.min(1200, Math.max(120, span.duration_ms)));
    }

    if (effectiveFrom && effectiveFrom !== to_node) {
      const parentStartNs = span.parent_span_id
        ? spanStartTimeRef.current.get(span.parent_span_id)
        : undefined;
      const edge_latency_ms = parentStartNs != null
        ? (span.start_time_unix_nano - parentStartNs) / 1_000_000
        : null;
      const rawMs   = edge_latency_ms ?? span.duration_ms;
      const pulseMs = Math.min(1200, Math.max(120, rawMs));
      st.renderer.activateEdge(effectiveFrom, to_node, frameTime, pulseMs);
      if (edge_latency_ms != null) st.renderer.addEdgeLatency(effectiveFrom, to_node, edge_latency_ms);
    }
  }, [rebuildMergedEdges, recordNodeSpan, flashSpanDot]);

  // ── Rebuild spans view and diagram after filter change ─────────────────────

  const rebuildFromFilter = useCallback(() => {
    const st = sharedRef.current;
    spansViewRef.current?.clear();
    st.nodeSpans       = new Map();
    st.renderer.clearActivity();
    st.activeExpiry    = new Map();
    st.spanVisibleNode = new Map();
    spanIdToNodeRef.current  = new Map();
    spanStartTimeRef.current = new Map();
    const now = performance.now();
    const traces = [...completedTracesRef.current].sort((a, b) => a.started_at - b.started_at);
    for (const trace of traces) {
      const sorted = [...trace.spans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
      for (const span of sorted) processSpan(span, now);
      st.inFlightSpans.delete(trace.trace_id);
      for (const s of trace.spans) {
        st.spanVisibleNode.delete(s.span_id);
        spanIdToNodeRef.current.delete(s.span_id);
        spanStartTimeRef.current.delete(s.span_id);
      }
      spansViewRef.current?.enrich(trace.spans);
    }
  }, [processSpan]);

  useEffect(() => {
    const handler = () => rebuildFromFilter();
    window.addEventListener('hidden-instances-changed', handler);
    return () => window.removeEventListener('hidden-instances-changed', handler);
  }, [rebuildFromFilter]);

  // When history traces are loaded, reset the shared state and inject synthetic topology.
  const prevHistoryTracesRef = useRef<TraceComplete[]>([]);
  useEffect(() => {
    const traces = historyPlayback.traces;
    if (traces === prevHistoryTracesRef.current) return;
    prevHistoryTracesRef.current = traces;
    if (!historyPlayback.historyEnabled || traces.length === 0) return;

    // Reset live shared state (clear layout, spans, animations)
    const st = sharedRef.current;
    st.layout.clear();
    st.serverEdges      = [];
    st.clientEdgeMap    = new Map();
    st.edges            = [];
    st.spanQueue        = [];
    st.nodeSpans        = new Map();
    st.inFlightSpans    = new Map();
    st.spanVisibleNode  = new Map();
    st.activeExpiry     = new Map();
    st.traceHL          = null;
    st.selectionHL      = null;
    st.renderer.clearActivity();

    // Build topology from all loaded traces (same scheme as live spans_batch handler)
    const nodeMap = new Map<string, Node>();
    const edgeMap = new Map<string, Edge>();

    const addHierarchyEdges = (target: string) => {
      const parts = target.split('::');
      for (let i = 0; i < parts.length; i++) {
        const nodeId   = parts.slice(0, i + 1).join('::');
        const category = parts.slice(0, Math.min(i + 1, 2)).join('::');
        if (!nodeMap.has(nodeId)) nodeMap.set(nodeId, { id: nodeId, label: parts[i], category, span_count: 0 });
        nodeMap.get(nodeId)!.span_count++;
        if (i > 0) {
          const parentId = parts.slice(0, i).join('::');
          const ek = `${parentId}=>${nodeId}`;
          if (!edgeMap.has(ek)) edgeMap.set(ek, { source: parentId, target: nodeId, flow_count: 0 });
          edgeMap.get(ek)!.flow_count++;
        }
      }
    };

    for (const trace of traces) {
      const spanTargetById = new Map<string, string>(trace.spans.map(s => [s.span_id, s.target]));
      for (const span of trace.spans) {
        addHierarchyEdges(span.target);
        // Cross-target edge from span parent
        if (span.parent_span_id) {
          const parentTarget = spanTargetById.get(span.parent_span_id);
          if (parentTarget && parentTarget !== span.target) {
            const ek = `${parentTarget}=>${span.target}`;
            if (!edgeMap.has(ek)) edgeMap.set(ek, { source: parentTarget, target: span.target, flow_count: 0 });
            edgeMap.get(ek)!.flow_count++;
          }
        }
      }
    }

    // Apply topology directly from history trace spans
    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeMap.values());
    {
      const hiddenIds    = new Set(nodes.filter(n => isSpanHidden({ name: n.label, target: n.id })).map(n => n.id));
      const visibleNodes = nodes.filter(n => !hiddenIds.has(n.id));
      const parentOf     = new Map<string, string>();
      for (const e of edges) if (!parentOf.has(e.target)) parentOf.set(e.target, e.source);
      const nearestVisibleAncestor = (id: string): string | null => {
        let cur = parentOf.get(id);
        while (cur !== undefined) { if (!hiddenIds.has(cur)) return cur; cur = parentOf.get(cur); }
        return null;
      };
      const reWiredEdges: Edge[] = [];
      const edgeSet = new Set<string>();
      for (const e of edges) {
        if (hiddenIds.has(e.target)) continue;
        const effectiveSrc = hiddenIds.has(e.source) ? nearestVisibleAncestor(e.source) : e.source;
        if (!effectiveSrc || effectiveSrc === e.target) continue;
        const key = `${effectiveSrc}=>${e.target}`;
        if (!edgeSet.has(key)) { edgeSet.add(key); reWiredEdges.push({ source: effectiveSrc, target: e.target, flow_count: e.flow_count }); }
      }
      st.layout.upsert(visibleNodes);
      st.serverEdges = reWiredEdges;
      for (const e of reWiredEdges) st.clientEdgeMap.delete(`${e.source}=>${e.target}`);
      rebuildMergedEdges();
      for (const n of visibleNodes) targetColor(n.category);
    }

    // Topology built — start cursor before all traces so playback drives data population
    setHasData(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyPlayback.traces, historyPlayback.historyEnabled]);

  const handleMessage = useCallback((msg: WsMessage) => {
    const st = sharedRef.current;

    // While in history mode, ignore live span/trace updates to avoid
    // polluting the history view. WS stays connected so we can resume live
    // instantly when the user toggles history off.
    if (historyEnabledRef.current) {
      if (msg.type === 'spans_batch') return;
    }

    switch (msg.type) {
      case 'spans_batch': {
        if (msg.spans.length > 0) setHasReceivedTraces(true);

        // ── Build topology incrementally from spans ─────────────────────────────────────

        // Index this batch's span_id → node_id first (two-pass within the batch)
        // so cross-span parent references resolve correctly.
        // Node ID = span.target: one node per module/component, depth from '::' segments.
        const batchNodeId = new Map<string, string>();
        for (const s of msg.spans) {
          const nodeId = s.target;
          batchNodeId.set(s.span_id, nodeId);
          spanIdToNodeRef.current.set(s.span_id, nodeId);
        }

        const newNodes: Node[] = [];
        const newEdges: Edge[] = [];
        const st = sharedRef.current;

        // Helper: ensure a node exists and add target-hierarchy edges
        // e.g. 'amaru::chain::validation' adds nodes+edges for each prefix
        // category = up to 2 '::' levels of the node's own id, so colors match legend
        const ensureTargetPath = (target: string) => {
          const parts = target.split('::');
          for (let i = 0; i < parts.length; i++) {
            const nodeId   = parts.slice(0, i + 1).join('::');
            const category = parts.slice(0, Math.min(i + 1, 2)).join('::');
            if (!st.layout.nodes.has(nodeId) && !newNodes.some(n => n.id === nodeId)) {
              newNodes.push({ id: nodeId, label: parts[i], category, span_count: 1 });
            }
            if (i > 0) {
              const parentId = parts.slice(0, i).join('::');
              if (!st.serverEdges.some(e => e.source === parentId && e.target === nodeId) &&
                  !newEdges.some(e => e.source === parentId && e.target === nodeId)) {
                if (!edgeWouldCreateCycle(parentId, nodeId, [...st.serverEdges, ...newEdges])) {
                  newEdges.push({ source: parentId, target: nodeId, flow_count: 1 });
                }
              }
            }
          }
        };

        for (const s of msg.spans) {
          const nodeId = s.target;
          ensureTargetPath(s.target);
          // Cross-target edges from span parent_span_id
          if (s.parent_span_id) {
            const parentNodeId = batchNodeId.get(s.parent_span_id)
              ?? spanIdToNodeRef.current.get(s.parent_span_id);
            if (parentNodeId && parentNodeId !== nodeId) {
              if (!st.serverEdges.some(e => e.source === parentNodeId && e.target === nodeId) &&
                  !newEdges.some(e => e.source === parentNodeId && e.target === nodeId)) {
                if (!edgeWouldCreateCycle(parentNodeId, nodeId, [...st.serverEdges, ...newEdges])) {
                  newEdges.push({ source: parentNodeId, target: nodeId, flow_count: 1 });
                }
              }
            }
          }
        }

        if (newNodes.length > 0 || newEdges.length > 0) {
          const hiddenIds = new Set(newNodes.filter(n => isSpanHidden({ name: n.label, target: n.id })).map(n => n.id));
          const visibleNodes = newNodes.filter(n => !hiddenIds.has(n.id));
          st.layout.upsert(visibleNodes);
          for (const n of visibleNodes) targetColor(n.category);
          for (const e of newEdges) {
            if (!hiddenIds.has(e.source) && !hiddenIds.has(e.target)) {
              st.serverEdges.push(e);
              st.clientEdgeMap.delete(`${e.source}=>${e.target}`);
            }
          }
          rebuildMergedEdges();
          tracesPanelRef.current?.setMermaidDirty();
          if (visibleNodes.length > 0) setHasData(true);
        }

        for (const item of msg.spans) st.spanQueue.push(item);
        break;
      }

    }
  }, [rebuildMergedEdges]);

  // ── WS status handler ────────────────────────────────────────────────────────
  const handleStatus = useCallback((connected: boolean) => {
    wsConnectedRef.current = connected;
    if (demoModeRef.current) return;
    setWsConnected(connected);
  }, []);

  // ── WebSocket ────────────────────────────────────────────────────────────────
  useWebSocket({ url: WS_URL, onMessage: handleMessage, onStatus: handleStatus });

  // ── rAF frame loop (span queue drain + rate metrics) ───────────────────────
  useEffect(() => {
    let rafId: number;
    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame);
      const st = sharedRef.current;

      // Drain span queue (max 200/frame) — skip in history mode
      if (!historyEnabledRef.current && st.spanQueue.length > 0) {
        const pending = st.spanQueue.splice(0, Math.min(st.spanQueue.length, 200));
        pending.sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
        const minNs   = pending.reduce((m, s) => Math.min(m, s.start_time_unix_nano), Infinity);
        const maxNs   = pending.reduce((m, s) => Math.max(m, s.start_time_unix_nano), -Infinity);
        const rangeNs = maxNs - minNs || 1;
        for (const m of pending) {
          const staggerMs = ((m.start_time_unix_nano - minNs) / rangeNs) * 300;
          processSpan(m, now + staggerMs);
        }

        // Finalize any completed traces (root span signals completion)
        for (const m of pending) {
          if (m.parent_span_id !== null) continue;
          const spans = st.inFlightSpans.get(m.trace_id) ?? [];
          st.inFlightSpans.delete(m.trace_id);
          for (const s of spans) {
            st.spanVisibleNode.delete(s.span_id);
            spanIdToNodeRef.current.delete(s.span_id);
            spanStartTimeRef.current.delete(s.span_id);
          }
          spansViewRef.current?.enrich(spans);
          if (hiddenRules.length && spans.every(s => isSpanHidden(s))) continue;
          st.tracesThisSecond++;
          const root = spans.find(s => s.parent_span_id === null) ?? m;
          const startedAt = spans.reduce((acc, s) => Math.min(acc, s.start_time_unix_nano), Infinity);
          const endedAt   = spans.reduce((acc, s) => Math.max(acc, s.end_time_unix_nano), -Infinity);
          const trace: TraceComplete = {
            trace_id:       m.trace_id,
            spans,
            root_span_name: root.name,
            duration_ms:    startedAt === Infinity ? 0 : (endedAt - startedAt) / 1_000_000,
            started_at:     startedAt === Infinity ? 0 : startedAt,
            instance_id:    root.instance_id ?? '',
          };
          tracesPanelRef.current?.onTraceCompleted(trace, activeTabRef.current);
          setCompletedTraces(prev => {
            const cutoff = (Date.now() - STATS_WINDOW_MS) * 1_000_000;
            return [...prev.filter(tr => tr.started_at >= cutoff), trace];
          });
          setHasData(true);
        }
      }

      // History mode: replay traces that the cursor has crossed this frame
      if (historyEnabledRef.current && historyPlayback.traces.length > 0) {
        const cursor = historyPlayback.cursorRef.current;
        const prev   = histLastCursorRef.current;
        if (cursor !== prev) {
          const backward = cursor < prev;
          if (backward) {
            // Backward seek: wipe all per-trace data and replay from the start
            setCompletedTraces([]);
            spansViewRef.current?.clear();
            tracesPanelRef.current?.clear();
            st.renderer.clearActivity();
            st.inFlightSpans   = new Map();
            st.spanVisibleNode = new Map();
            st.activeExpiry    = new Map();
            spanIdToNodeRef.current  = new Map();
            spanStartTimeRef.current = new Map();
          }
          const fromNs = backward ? historyPlayback.range.from - 1 : prev;
          const newlyVisible: TraceComplete[] = [];
          for (const trace of historyPlayback.traces) {
            if (trace.started_at > fromNs && trace.started_at <= cursor) {
              const sorted = [...trace.spans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
              for (const span of sorted) processSpan(span, now);
              st.inFlightSpans.delete(trace.trace_id);
              for (const s of trace.spans) {
                st.spanVisibleNode.delete(s.span_id);
                spanIdToNodeRef.current.delete(s.span_id);
                spanStartTimeRef.current.delete(s.span_id);
              }
              spansViewRef.current?.enrich(trace.spans);
              tracesPanelRef.current?.onTraceCompleted(trace, activeTabRef.current);
              newlyVisible.push(trace);
              st.tracesThisSecond++;
            }
          }
          if (backward) {
            setCompletedTraces(newlyVisible);
          } else if (newlyVisible.length > 0) {
            setCompletedTraces(prevTraces => [...prevTraces, ...newlyVisible]);
          }
          // Pin the current cursor trace so its nodes/edges stay lit in the diagram
          const cursorTrace = historyPlayback.traces[historyPlayback.cursorIndexRef.current];
          if (cursorTrace) {
            const nodeIds  = new Set<string>();
            const edgeKeys = new Set<string>();
            for (const span of cursorTrace.spans) {
              const toNode   = `${span.target}::${span.name}`;
              const fromNode = span.parent_span_id ? spanIdToNodeRef.current.get(span.parent_span_id) : undefined;
              nodeIds.add(toNode);
              if (fromNode && fromNode !== toNode) edgeKeys.add(`${fromNode}=>${toNode}`);
            }
            st.renderer.pinTrace(nodeIds, edgeKeys);
          }
          histLastCursorRef.current = cursor;
        }
      }

      // Update sps/tps once per second using actual elapsed time and
      // a two-window average to smooth out batch-arrival jitter.
      if (now - st.lastRateUpdate >= 1000) {
        const elapsed  = now - st.lastRateUpdate;
        const instantSps = st.spansThisSecond  * 1000 / elapsed;
        const instantTps = st.tracesThisSecond * 1000 / elapsed;
        st.spsSmoothed = (st.spsSmoothed + instantSps) / 2;
        st.tpsSmoothed = (st.tpsSmoothed + instantTps) / 2;
        setSps(Math.round(st.spsSmoothed));
        setTps(Math.round(st.tpsSmoothed));
        st.spansThisSecond  = 0;
        st.tracesThisSecond = 0;
        st.lastRateUpdate   = now;
      }
    };
    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [processSpan, historyPlayback]);

  // ── Demo mode ────────────────────────────────────────────────────────────────
  const activateDemo = useCallback((scenario: DemoScenario = 'standard') => {
    if (demoModeRef.current) return;
    setDemoConfig(demoConfig);
    setDemoMode(true);
    setDemoScenario(scenario);
    setHasData(true);
    setWelcomeVisible(false);
    setWsConnected(false); // show demo status, not ws status
    setHasReceivedTraces(true);
    demoCleanupRef.current = startDemo(handleMessage, scenario);
  }, [handleMessage, demoConfig]);

  const handleDemoConfigChange = useCallback((c: DemoConfig) => {
    setDemoConfig(c);
    setDemoConfigState(c);
  }, []);

  const deactivateDemo = useCallback(() => {
    if (!demoModeRef.current) return;
    setDemoMode(false);
    setHasData(false);
    setWelcomeVisible(true);
    setCompletedTraces([]);
    setHasReceivedTraces(false);
    demoCleanupRef.current?.();
    demoCleanupRef.current = null;
    setWsConnected(wsConnectedRef.current);
  }, []);

  const resetToWelcome = useCallback(() => {
    if (demoModeRef.current) {
      demoCleanupRef.current?.();
      demoCleanupRef.current = null;
      setDemoMode(false);
    }
    setHasData(false);
    setWelcomeVisible(true);
    setCompletedTraces([]);
    setHasReceivedTraces(false);
    setWsConnected(wsConnectedRef.current);
  }, []);

  // ── Periodic pruning of stats traces outside the rolling window ──────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (historyEnabledRef.current) return; // don't prune in history mode
      setCompletedTraces(prev => {
        if (!prev.length) return prev;
        const cutoff = (Date.now() - STATS_WINDOW_MS) * 1_000_000;
        const next = prev.filter(t => t.started_at >= cutoff);
        return next.length === prev.length ? prev : next;
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Node selection ────────────────────────────────────────────────────────────
  const handleNodeSelect = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (!nodeId) sharedRef.current.selectionHL = null;
  }, []);

  // ── Tab switching ─────────────────────────────────────────────────────────────
  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    if (tab === 'spans')  spansViewRef.current?.clearUnread();
    if (tab === 'traces') tracesPanelRef.current?.onTabEntered();
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showHideRules) { setShowHideRules(false); return; }
      if (selectedNodeId) handleNodeSelect(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showHideRules, selectedNodeId, handleNodeSelect]);

  // ── Highlight change callbacks ─────────────────────────────────────────────
  const handleTraceHighlight = useCallback(
    (hl: { nodes: Set<string>; edgeKeys: Set<string> } | null) => {
      sharedRef.current.traceHL = hl;
    },
    [],
  );

  const handleSelectionHighlight = useCallback(
    (hl: { nodes: Set<string>; edgeKeys: Set<string> } | null) => {
      sharedRef.current.selectionHL = hl;
    },
    [],
  );

  // ── Getters passed to child components ────────────────────────────────────
  const getEdges       = useCallback(() => sharedRef.current.edges, []);
  const getLayoutNodes = useCallback((): Map<string, LayoutNode> => sharedRef.current.layout.nodes, []);

  return (
    <div id="app" className={[
      !hasData ? 'no-data' : '',
      activeTab === 'spans'      ? 'spans-active'      : '',
      activeTab === 'traces'     ? 'traces-active'     : '',
      activeTab === 'statistics' ? 'statistics-active' : '',
    ].filter(Boolean).join(' ')}>

      <Header
        activeTab={activeTab}
        onTabChange={handleTabChange}
        wsConnected={wsConnected}
        demoMode={demoMode}
        demoScenario={demoScenario}
        onExitDemo={deactivateDemo}
        demoConfig={demoConfig}
        onDemoConfigChange={handleDemoConfigChange}
        onLogoClick={resetToWelcome}
        sps={sps}
        tps={tps}
        spansFlashing={spansFlashing}
        onOpenFilters={() => setShowHideRules(true)}
        historyPlayback={historyPlayback}
      />

      <WelcomeScreen
        wsConnected={wsConnected}
        welcomeVisible={welcomeVisible}
        onConnectLive={() => setWelcomeVisible(false)}
        onEnterDemo={activateDemo}
        historyPlayback={historyPlayback}
        hasReceivedTraces={hasReceivedTraces}
      />

      <DiagramView
        ref={diagramViewRef}
        sharedRef={sharedRef}
        activeTab={activeTab}
        selectedNodeId={selectedNodeId}
        onNodeSelect={handleNodeSelect}
      />

      <SpansView
        ref={spansViewRef}
        lookupFullSpan={lookupSpan}
      />

      <TracesPanel
        ref={tracesPanelRef}
        activeTab={activeTab}
        inFlightSpans={sharedRef.current.inFlightSpans}
        getEdges={getEdges}
        getLayoutNodes={getLayoutNodes}
        onTraceHighlightChange={handleTraceHighlight}
      />

      <NodeDetailPanel
        ref={nodeDetailRef}
        selectedNodeId={selectedNodeId}
        nodeSpans={sharedRef.current.nodeSpans}
        getEdges={getEdges}
        getLayoutNodes={getLayoutNodes}
        layout={sharedRef.current.layout}
        onClose={() => handleNodeSelect(null)}
        onNodeSelect={id => handleNodeSelect(id)}
        onSelectionHighlightChange={handleSelectionHighlight}
      />

      <StatisticsView traces={completedTraces} totalSeen={completedTraces.length} />

      <HideRulesDialog
        open={showHideRules}
        onClose={() => setShowHideRules(false)}
        knownInstances={knownInstances}
      />
    </div>
  );
}
