// ── App: root component and orchestration layer ───────────────────────────────

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
} from 'react';

import { Layout }          from './canvas/layout.ts';
import { Renderer }        from './canvas/renderer.ts';
import { Camera }          from './canvas/camera.ts';
import { targetColor }     from './core/colors.ts';
import { edgeWouldCreateCycle } from './core/graph.ts';
import { loadDefaultFilters, hiddenRules, isSpanHidden } from './panels/hide-rules.ts';
import { startDemo }       from './core/demo.ts';
import { useWebSocket }    from './hooks/useWebSocket.ts';
import type { SpanEvent, WsMessage, Edge, Node, SpanArrivedPayload, TraceComplete } from './core/types.ts';

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
  spanQueue:      SpanArrivedPayload[];
  nodeSpans:      Map<string, SpanEvent[]>;
  inFlightSpans:  Map<string, SpanEvent[]>;
  spanVisibleNode: Map<string, string | null>;
  activeExpiry:   Map<string, number>;
  spansThisSecond:  number;
  tracesThisSecond: number;
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
const MAX_STATS_TRACES = 500;

// ── Component ──────────────────────────────────────────────────────────────────

export default function App() {
  // ── React state ────────────────────────────────────────────────────────────
  const [wsConnected,    setWsConnected]    = useState(false);
  const [demoMode,       setDemoMode]       = useState(false);
  const [activeTab,      setActiveTab]      = useState<TabId>('diagram');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hasData,        setHasData]        = useState(false);
  const [sps,              setSps]              = useState(0);
  const [tps,              setTps]              = useState(0);
  const [spansFlashing,    setSpansFlashing]    = useState(false);
  const [showHideRules,    setShowHideRules]    = useState(false);
  const [completedTraces,  setCompletedTraces]  = useState<TraceComplete[]>([]);
  const [totalTracesSeen,  setTotalTracesSeen]  = useState(0);
  const totalTracesSeenRef = useRef(0);

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

  // ── WS message handler ──────────────────────────────────────────────────────
  const handleMessage = useCallback((msg: WsMessage) => {
    const st = sharedRef.current;

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
        for (const e of reWiredEdges) st.clientEdgeMap.delete(`${e.source}=>${e.target}`);
        rebuildMergedEdges();
        for (const n of visibleNodes) targetColor(n.category);
        tracesPanelRef.current?.setMermaidDirty();

        if (visibleNodes.length > 0) setHasData(true);
        break;
      }

      case 'spans_batch':
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
        totalTracesSeenRef.current++;
        const n = totalTracesSeenRef.current;
        setTotalTracesSeen(n);
        setCompletedTraces(prev => {
          // Reservoir sampling (Algorithm R): uniform random sample of all traces ever seen
          if (prev.length < MAX_STATS_TRACES) return [...prev, t];
          const j = Math.floor(Math.random() * n);
          if (j < MAX_STATS_TRACES) {
            const next = [...prev];
            next[j] = t;
            return next;
          }
          return prev;
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
  useWebSocket({ url: WS_URL, onMessage: handleMessage, onStatus: handleStatus });

  // ── rAF frame loop (span queue drain + rate metrics) ───────────────────────
  useEffect(() => {
    let rafId: number;
    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame);
      const st = sharedRef.current;

      // Drain span queue (max 200/frame)
      if (st.spanQueue.length > 0) {
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

      // Update sps/tps once per second
      if (now - st.lastRateUpdate >= 1000) {
        setSps(st.spansThisSecond);
        setTps(st.tracesThisSecond);
        st.spansThisSecond  = 0;
        st.tracesThisSecond = 0;
        st.lastRateUpdate   = now;
      }
    };
    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [processSpan]);

  // ── Demo mode ────────────────────────────────────────────────────────────────
  const activateDemo = useCallback(() => {
    if (demoModeRef.current) return;
    setDemoMode(true);
    setHasData(true);
    setWsConnected(false); // show demo status, not ws status
    demoCleanupRef.current = startDemo(handleMessage);
  }, [handleMessage]);

  const deactivateDemo = useCallback(() => {
    if (!demoModeRef.current) return;
    setDemoMode(false);
    setHasData(false);
    setCompletedTraces([]);
    setTotalTracesSeen(0);
    totalTracesSeenRef.current = 0;
    demoCleanupRef.current?.();
    demoCleanupRef.current = null;
    setWsConnected(wsConnectedRef.current);
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
        onExitDemo={deactivateDemo}
        sps={sps}
        tps={tps}
        spansFlashing={spansFlashing}
        onOpenFilters={() => setShowHideRules(true)}
      />

      <WelcomeScreen
        wsConnected={wsConnected}
        demoMode={demoMode}
        hasData={hasData}
        onEnterDemo={activateDemo}
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

      <StatisticsView traces={completedTraces} totalSeen={totalTracesSeen} />

      <HideRulesDialog
        open={showHideRules}
        onClose={() => setShowHideRules(false)}
      />
    </div>
  );
}
