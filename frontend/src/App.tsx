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
import { loadDefaultFilters, hiddenRules, isSpanHidden } from './panels/hide-rules.ts';
import { startDemo, setDemoConfig, DEFAULT_DEMO_CONFIG } from './core/demo.ts';
import type { DemoScenario, DemoConfig } from './core/demo.ts';
import { useWebSocket }    from './hooks/useWebSocket.ts';
import { useHistoryPlayback } from './hooks/useHistoryPlayback.ts';
import { useCorrelationKeyPreference } from './hooks/useCorrelationKeyPreference.ts';
import type { SpanEvent, WsMessage, Edge, Node, SpanArrivedPayload, TraceComplete } from './core/types.ts';

import Header          from './components/Header.tsx';
import WelcomeScreen   from './components/WelcomeScreen.tsx';
import StatisticsView  from './components/StatisticsView.tsx';
import DiagramView     from './components/DiagramView.tsx';
import SpansView       from './components/SpansView.tsx';
import TracesPanel     from './components/TracesPanel.tsx';
import NodeDetailPanel from './components/NodeDetailPanel.tsx';
import HideRulesDialog from './components/HideRulesDialog.tsx';
import CorrelationKeyDialog from './components/CorrelationKeyDialog.tsx';

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
  spanQueue:      SpanArrivedPayload[];
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
  const [showCorrelationKeyDialog, setShowCorrelationKeyDialog] = useState(false);
  const [completedTraces,  setCompletedTraces]  = useState<TraceComplete[]>([]);
  const [hasReceivedTraces, setHasReceivedTraces] = useState(false);

  // ── Correlation key preference ─────────────────────────────────────────────
  const correlationKeyPref = useCorrelationKeyPreference();

  const knownInstances = useMemo(() => {
    const seen = new Set<string>();
    for (const t of completedTraces) if (t.instance_id) seen.add(t.instance_id);
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
      // Exiting history: clear transient state and request a fresh live topology
      // snapshot so the diagram re-syncs with live data.
      // NOTE: we do NOT call st.layout.clear() here — layout.upsert() inside the
      // topology_snapshot handler already removes stale nodes, so pre-clearing would
      // leave the canvas blank between the clear and the server response.
      histLastCursorRef.current = 0;
      setCompletedTraces([]);
      const st = sharedRef.current;
      st.renderer.clearActivity();
      st.serverEdges     = [];
      st.clientEdgeMap   = new Map();
      st.edges           = [];
      st.spanQueue       = [];
      st.nodeSpans       = new Map();
      st.inFlightSpans   = new Map();
      st.spanVisibleNode = new Map();
      st.activeExpiry    = new Map();
      wsSend('topology');
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
  useEffect(() => { activeTabRef.current = activeTab; },     [activeTab]);
  useEffect(() => { demoModeRef.current  = demoMode; },      [demoMode]);
  useEffect(() => { wsConnectedRef.current = wsConnected; }, [wsConnected]);

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
  const processSpan = useCallback((msg: SpanArrivedPayload, frameTime: number) => {
    const { to_node } = msg;
    const st = sharedRef.current;

    const span: SpanEvent = {
      trace_id:             msg.trace_id,
      span_id:              msg.span_id,
      parent_span_id:       msg.parent_span_id,
      name:                 msg.name,
      target:               msg.target,
      start_time_unix_nano: msg.start_time_unix_nano,
      end_time_unix_nano:   msg.end_time_unix_nano,
      duration_ms:          msg.duration_ms,
      status:               msg.status,
      service_name:         msg.service_name,
      instance_id:          msg.instance_id,
      attributes:           [],
    };

    const effectiveFrom: string | null = msg.parent_span_id
      ? (st.spanVisibleNode.get(msg.parent_span_id) ?? null)
      : null;

    if (hiddenRules.length && isSpanHidden(span)) {
      st.spanVisibleNode.set(msg.span_id, effectiveFrom);
      return;
    }

    st.spanVisibleNode.set(msg.span_id, to_node);

    // Dynamic edge learning
    const layoutFrom = effectiveFrom
      ?? (msg.from_node && msg.from_node !== to_node ? msg.from_node : null);
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

    const existing = st.inFlightSpans.get(msg.trace_id);
    if (existing) existing.push(span); else st.inFlightSpans.set(msg.trace_id, [span]);
    tracesPanelRef.current?.notifySpanInFlight(msg.trace_id);

    spansViewRef.current?.add(span, activeTabRef.current === 'spans');
    recordNodeSpan(to_node, span);
    nodeDetailRef.current?.notifySpanArrived(to_node, span.duration_ms);

    targetColor(span.target);
    const cat = st.layout.nodes.get(to_node)?.category ?? 'other';
    st.renderer.activateNode(to_node, cat, frameTime, span.name);
    st.activeExpiry.set(to_node, frameTime + 600);
    if (effectiveFrom && effectiveFrom !== to_node) {
      const rawMs   = msg.edge_latency_ms ?? span.duration_ms;
      const pulseMs = Math.min(1200, Math.max(120, rawMs));
      st.renderer.activateEdge(effectiveFrom, to_node, frameTime, pulseMs);
      if (msg.edge_latency_ms != null) st.renderer.addEdgeLatency(effectiveFrom, to_node, msg.edge_latency_ms);
    }
  }, [rebuildMergedEdges, recordNodeSpan, flashSpanDot]);

  // ── History utilities ───────────────────────────────────────────────────────

  /** Reconstruct a wire-format SpanArrivedPayload from a full SpanEvent. */
  const spanToArrivedPayload = useCallback((
    span: SpanEvent,
    spanById: Map<string, SpanEvent>,
  ): SpanArrivedPayload => {
    const nodeId = `${span.target}::${span.name}`;
    const parent = span.parent_span_id ? spanById.get(span.parent_span_id) : undefined;
    const fromNode = parent ? `${parent.target}::${parent.name}` : null;
    const edgeLatencyMs = parent
      ? (span.start_time_unix_nano - parent.start_time_unix_nano) / 1_000_000
      : null;
    return {
      trace_id:             span.trace_id,
      span_id:              span.span_id,
      parent_span_id:       span.parent_span_id,
      name:                 span.name,
      target:               span.target,
      start_time_unix_nano: span.start_time_unix_nano,
      end_time_unix_nano:   span.end_time_unix_nano,
      duration_ms:          span.duration_ms,
      status:               span.status,
      service_name:         span.service_name,
      from_node:            (fromNode && fromNode !== nodeId) ? fromNode : null,
      to_node:              nodeId,
      edge_latency_ms:      (edgeLatencyMs != null && edgeLatencyMs >= 0) ? edgeLatencyMs : null,
    };
  }, []);

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

    // Build topology from all loaded traces
    const nodeMap = new Map<string, Node>();
    const edgeMap = new Map<string, Edge>();
    for (const trace of traces) {
      const spanById = new Map<string, SpanEvent>(trace.spans.map(s => [s.span_id, s]));
      for (const span of trace.spans) {
        const nodeId = `${span.target}::${span.name}`;
        const n = nodeMap.get(nodeId);
        if (n) { n.span_count++; }
        else { nodeMap.set(nodeId, { id: nodeId, label: span.name, category: span.target, span_count: 1 }); }
        if (span.parent_span_id) {
          const parent = spanById.get(span.parent_span_id);
          if (parent) {
            const parentId = `${parent.target}::${parent.name}`;
            if (parentId !== nodeId) {
              const ek = `${parentId}=>${nodeId}`;
              const e = edgeMap.get(ek);
              if (e) { e.flow_count++; }
              else { edgeMap.set(ek, { source: parentId, target: nodeId, flow_count: 1 }); }
            }
          }
        }
      }
    }

    // Inject as a synthetic topology_snapshot (apply topology directly,
    // bypassing the live-message muting check in handleMessage)
    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeMap.values());
    {
      const hiddenIds    = new Set(nodes.filter(n => isSpanHidden({ name: n.id, target: n.category })).map(n => n.id));
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

    // While in history mode, ignore live topology/span updates to avoid
    // polluting the history view. WS stays connected so we can resume live
    // instantly when the user toggles history off.
    if (historyEnabledRef.current) {
      if (msg.type === 'topology_snapshot' || msg.type === 'topology_updated' ||
          msg.type === 'spans_batch' || msg.type === 'trace_completed') {
        return;
      }
    }

    switch (msg.type) {
      case 'topology_snapshot':
      case 'topology_updated': {
        const hiddenIds    = new Set(msg.nodes.filter(n => isSpanHidden({ name: n.id, target: n.category })).map(n => n.id));
        const visibleNodes = msg.nodes.filter(n => !hiddenIds.has(n.id));
        const parentOf     = new Map<string, string>();
        for (const e of msg.edges) if (!parentOf.has(e.target)) parentOf.set(e.target, e.source);

        function nearestVisibleAncestor(id: string): string | null {
          let cur = parentOf.get(id);
          while (cur !== undefined) {
            if (!hiddenIds.has(cur)) return cur;
            cur = parentOf.get(cur);
          }
          return null;
        }

        const reWiredEdges: Edge[] = [];
        const edgeSet = new Set<string>();
        for (const e of msg.edges) {
          if (hiddenIds.has(e.target)) continue;
          const effectiveSrc = hiddenIds.has(e.source) ? nearestVisibleAncestor(e.source) : e.source;
          if (!effectiveSrc || effectiveSrc === e.target) continue;
          const key = `${effectiveSrc}=>${e.target}`;
          if (!edgeSet.has(key)) { edgeSet.add(key); reWiredEdges.push({ source: effectiveSrc, target: e.target, flow_count: e.flow_count }); }
        }

        st.layout.upsert(visibleNodes);
        st.serverEdges = reWiredEdges;
        // Clear ALL client-derived edges so stale span edges from the previous
        // topology (e.g. after a depth change) don't survive the snapshot.
        st.clientEdgeMap = new Map();
        rebuildMergedEdges();
        for (const n of visibleNodes) targetColor(n.category);
        tracesPanelRef.current?.setMermaidDirty();

        if (visibleNodes.length > 0) setHasData(true);
        break;
      }

      case 'spans_batch':
        if (msg.spans.length > 0) setHasReceivedTraces(true);
        for (const item of msg.spans) st.spanQueue.push(item);
        break;

      case 'trace_completed': {
        const t = msg.trace;
        st.inFlightSpans.delete(t.trace_id);
        for (const s of t.spans) st.spanVisibleNode.delete(s.span_id);
        spansViewRef.current?.enrich(t.spans);
        if (hiddenRules.length && t.spans.every(s => isSpanHidden(s))) break;
        st.tracesThisSecond++;
        tracesPanelRef.current?.onTraceCompleted(t, activeTabRef.current);
        setCompletedTraces(prev => {
          const cutoff = (Date.now() - STATS_WINDOW_MS) * 1_000_000;
          const filtered = prev.filter(tr => tr.started_at >= cutoff);
          return [...filtered, t];
        });
        setHasData(true);
        break;
      }

      case 'stats':
        break;
    }
  }, [rebuildMergedEdges]);

  // ── WS status handler ────────────────────────────────────────────────────────
  const handleStatus = useCallback((connected: boolean) => {
    if (demoModeRef.current) return;
    setWsConnected(connected);
  }, []);

  // ── WebSocket ────────────────────────────────────────────────────────────────
  const { sendMessage: wsSend } = useWebSocket({ url: WS_URL, onMessage: handleMessage, onStatus: handleStatus });

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
          }
          const fromNs = backward ? historyPlayback.range.from - 1 : prev;
          const newlyVisible: TraceComplete[] = [];
          for (const trace of historyPlayback.traces) {
            if (trace.started_at > fromNs && trace.started_at <= cursor) {
              const spanById = new Map<string, SpanEvent>(trace.spans.map(s => [s.span_id, s]));
              const sorted = [...trace.spans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
              for (const span of sorted) processSpan(spanToArrivedPayload(span, spanById), now);
              st.inFlightSpans.delete(trace.trace_id);
              for (const s of trace.spans) st.spanVisibleNode.delete(s.span_id);
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
            const spanById = new Map<string, SpanEvent>(cursorTrace.spans.map(s => [s.span_id, s]));
            const nodeIds  = new Set<string>();
            const edgeKeys = new Set<string>();
            for (const span of cursorTrace.spans) {
              const p = spanToArrivedPayload(span, spanById);
              nodeIds.add(p.to_node);
              if (p.from_node && p.from_node !== p.to_node) edgeKeys.add(`${p.from_node}=>${p.to_node}`);
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
        onOpenCorrelationKeySettings={() => setShowCorrelationKeyDialog(true)}
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
        correlationKeyName={correlationKeyPref.effectiveKey}
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

      <CorrelationKeyDialog
        open={showCorrelationKeyDialog}
        onClose={() => setShowCorrelationKeyDialog(false)}
        serverKey={correlationKeyPref.serverKey}
        userPreference={correlationKeyPref.userPreference}
        onSave={correlationKeyPref.setPreference}
      />
    </div>
  );
}
