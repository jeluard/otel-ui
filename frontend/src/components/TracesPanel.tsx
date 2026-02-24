// ── TracesPanel: trace list, flamegraph, spans list, component diagram ────────

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { SpanEvent, Edge, TraceComplete } from '../core/types.ts';
import type { LayoutNode } from '../canvas/layout.ts';
import { drawFlamegraph } from '../canvas/flamegraph.ts';
import type { FlamegraphHitTest } from '../canvas/flamegraph.ts';
import { targetColor } from '../core/colors.ts';
import { fmtDur, escHtml } from '../core/utils.ts';
import { filterSpans, isSpanHidden } from '../panels/hide-rules.ts';
import { C } from '../core/theme.ts';
import type { TabId } from '../App.tsx';

// ── Pure helper functions (testable) ─────────────────────────────────────────

export function calcDepths(spans: SpanEvent[]): Map<string, number> {
  const byId = new Map<string, SpanEvent>();
  for (const s of spans) byId.set(s.span_id, s);
  const depthOf = new Map<string, number>();

  const calc = (s: SpanEvent, visiting = new Set<string>()): number => {
    if (depthOf.has(s.span_id)) return depthOf.get(s.span_id)!;
    if (visiting.has(s.span_id)) return 0;
    visiting.add(s.span_id);
    const parent = s.parent_span_id ? byId.get(s.parent_span_id) : null;
    const d = parent ? calc(parent, visiting) + 1 : 0;
    depthOf.set(s.span_id, d);
    return d;
  };
  for (const s of spans) calc(s);
  return depthOf;
}

export function buildMermaidSrc(
  edges: Edge[],
  layoutNodes: Map<string, LayoutNode>,
): string {
  if (edges.length === 0) return '';
  const sid = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
  const lines: string[] = ['stateDiagram-v2', '  direction LR'];
  for (const [id] of layoutNodes) {
    const safe = sid(id);
    if (safe !== id) lines.push(`  state "${id.replace(/"/g, '\\"')}" as ${safe}`);
  }
  for (const edge of edges) lines.push(`  ${sid(edge.source)} --> ${sid(edge.target)}`);
  return lines.join('\n');
}

export function computeTraceHighlight(
  spans: SpanEvent[],
  edges: Edge[],
  layoutNodes: Map<string, LayoutNode>,
): { nodes: Set<string>; edgeKeys: Set<string> } | null {
  const nodeSet = new Set<string>();
  for (const span of spans) {
    const otlpId = `${span.target}::${span.name}`;
    if (layoutNodes.has(otlpId)) nodeSet.add(otlpId);
    else if (layoutNodes.has(span.service_name)) nodeSet.add(span.service_name);
  }
  if (nodeSet.size === 0) return null;
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (nodeSet.has(edge.source) && nodeSet.has(edge.target))
      edgeKeys.add(`${edge.source}=>${edge.target}`);
  }
  return { nodes: nodeSet, edgeKeys };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type DetailTab = 'flame' | 'spans';

const MAX_RECENT = 200;
const TRC_MM_W = 140;
const TRC_MM_H = 90;

export interface TracesPanelHandle {
  onTraceCompleted(trace: TraceComplete, activeTab: TabId): void;
  notifySpanInFlight(traceId: string): void;
  setMermaidDirty(): void;
  onTabEntered(): void;
  /** Current trace highlight for the diagram. */
  getTraceHL(): { nodes: Set<string>; edgeKeys: Set<string> } | null;
  /** Look up a span by ID from completed traces (has full attributes). */
  lookupSpan(spanId: string): SpanEvent | undefined;
}

interface TracesPanelProps {
  activeTab: TabId;
  inFlightSpans: Map<string, SpanEvent[]>;
  getEdges: () => Edge[];
  getLayoutNodes: () => Map<string, LayoutNode>;
  onTraceHighlightChange: (hl: { nodes: Set<string>; edgeKeys: Set<string> } | null) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const TracesPanel = forwardRef<TracesPanelHandle, TracesPanelProps>(
  function TracesPanel({ activeTab, inFlightSpans, getEdges, getLayoutNodes, onTraceHighlightChange }, ref) {
    const [traces, setTraces]               = useState<TraceComplete[]>([]);
    const [selectedId, setSelectedId]       = useState<string | null>(null);
    const [detailTab, setDetailTab]         = useState<DetailTab>('flame');
    const [showHidden, setShowHidden]       = useState(false);
    const [mmZoomPct, setMmZoomPct]         = useState(100);
    // Freeze the list while the mouse is over it so items don't shift mid-click
    const [listFrozen, setListFrozen]       = useState(false);
    const frozenTracesRef                   = useRef<TraceComplete[]>([]);

    // Mutable refs (avoid triggering React re-renders for high-freq updates)
    const tracehlRef         = useRef<{ nodes: Set<string>; edgeKeys: Set<string> } | null>(null);
    const flameDirtyRef      = useRef(false);
    const mermaidDirtyRef    = useRef(true);
    const mmZoomRef          = useRef(1);
    const mmPanRef           = useRef({ x: 12, y: 12 });

    // DOM refs
    const flameCanvasRef   = useRef<HTMLCanvasElement>(null);
    const flameTipRef      = useRef<HTMLDivElement>(null);
    const flameHitTestRef  = useRef<FlamegraphHitTest>(() => null);
    const mermaidInnerRef  = useRef<HTMLDivElement>(null);
    const mermaidContRef   = useRef<HTMLDivElement>(null);
    const trcMmRef         = useRef<HTMLDivElement>(null);
    const trcMmVpRef       = useRef<HTMLDivElement>(null);
    const trcMmCanvasRef   = useRef<HTMLCanvasElement>(null);

    // Stable getter refs
    const tracesRef    = useRef<TraceComplete[]>([]);
    const selectedIdRef = useRef<string | null>(null);
    const detailTabRef  = useRef<DetailTab>('flame');
    useEffect(() => { tracesRef.current     = traces;    }, [traces]);
    useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
    useEffect(() => { detailTabRef.current  = detailTab;  }, [detailTab]);

    // ── Imperative handle ────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      onTraceCompleted(trace, tab) {
        // Update tracesRef eagerly (before setTraces commits) so that any
        // high-priority re-render racing with this batch (e.g. the user clicking
        // the "show hidden" checkbox) sees the completed trace instead of an empty
        // span list — inFlightSpans is deleted synchronously before this is called.
        const next = [trace, ...tracesRef.current];
        if (next.length > MAX_RECENT) next.pop();
        tracesRef.current = next;
        setTraces(next);
        if (trace.trace_id === selectedIdRef.current) flameDirtyRef.current = true;
        if (tab !== 'traces') {
          // Don't flush immediately; React batches this automatically
        }
      },
      notifySpanInFlight(traceId) {
        if (traceId === selectedIdRef.current) flameDirtyRef.current = true;
      },
      setMermaidDirty() { mermaidDirtyRef.current = true; },
      onTabEntered()    {
        if (mermaidDirtyRef.current) renderMermaid();
        if (selectedIdRef.current) redrawSelected(selectedIdRef.current);
      },
      getTraceHL() { return tracehlRef.current; },
      lookupSpan(spanId: string) {
        for (const t of tracesRef.current) {
          const s = t.spans.find(s => s.span_id === spanId);
          if (s) return s;
        }
        return undefined;
      },
    }));

    // ── Highlight matching nodes in the mermaid SVG ──────────────────────
    const highlightMermaidNodes = useCallback(() => {
      const inner = mermaidInnerRef.current;
      if (!inner) return;
      const hl = tracehlRef.current;
      const nodeEls = inner.querySelectorAll<SVGGElement>('g.node[id], g[class*="statediagram-state"][id]');
      if (!hl || nodeEls.length === 0) {
        nodeEls.forEach(el => el.classList.remove('trc-hl-active', 'trc-hl-dim'));
        return;
      }
      const sid = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');
      const hlSids = new Set([...hl.nodes].map(sid));
      nodeEls.forEach(el => {
        const id = el.getAttribute('id') ?? '';
        // mermaid stateDiagram-v2 node IDs: "state-{safeName}-{N}"
        const highlighted = [...hlSids].some(safeName =>
          id === `state-${safeName}` || id.startsWith(`state-${safeName}-`)
        );
        el.classList.toggle('trc-hl-active', highlighted);
        el.classList.toggle('trc-hl-dim',   !highlighted);
      });
    }, []);

    // ── Select a trace ───────────────────────────────────────────────────
    const selectTrace = useCallback((traceId: string) => {
      if (traceId === selectedIdRef.current) {
        selectedIdRef.current = null;   // eager update — avoids stale ref in frozen-list filter
        setSelectedId(null);
        tracehlRef.current = null;
        onTraceHighlightChange(null);
        highlightMermaidNodes();
        return;
      }
      selectedIdRef.current = traceId; // eager update — avoids stale ref in frozen-list filter
      setSelectedId(traceId);
      setShowHidden(false);
      flameDirtyRef.current = false;

      const trace = tracesRef.current.find(t => t.trace_id === traceId);
      const spans = trace?.spans ?? inFlightSpans.get(traceId) ?? [];
      const hl    = computeTraceHighlight(spans, getEdges(), getLayoutNodes());
      tracehlRef.current = hl;
      onTraceHighlightChange(hl);
      highlightMermaidNodes();

      // Draw flamegraph after selection
      requestAnimationFrame(() => redrawSelected(traceId));
    }, [inFlightSpans, getEdges, getLayoutNodes, onTraceHighlightChange, highlightMermaidNodes]);

    // ── Redraw flamegraph for selected trace ─────────────────────────────
    const redrawSelected = useCallback((traceId: string) => {
      const canvas = flameCanvasRef.current;
      if (!canvas) return;
      const completed = tracesRef.current.find(t => t.trace_id === traceId);
      const partial   = inFlightSpans.get(traceId);
      const spans: SpanEvent[] = completed ? completed.spans : partial ?? [];
      if (spans.length === 0) return;

      const sorted = [...spans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
      const tMin   = sorted[0].start_time_unix_nano;
      const tMax   = sorted.reduce((m, s) => Math.max(m, s.end_time_unix_nano), 0);
      const root   = sorted.find(s => !s.parent_span_id);
      const synth: TraceComplete = {
        trace_id:       traceId,
        spans:          sorted,
        root_span_name: root?.name ?? '',
        duration_ms:    (tMax - tMin) / 1_000_000,
        started_at:     tMin,
      };
      canvas.style.display = 'block';
      flameHitTestRef.current = drawFlamegraph(synth, canvas, filterSpans);
    }, [inFlightSpans]);

    // Tick flame dirty from a frame loop (only when traces tab is active)
    useEffect(() => {
      if (activeTab !== 'traces') return;
      let rafId: number;
      const tick = () => {
        rafId = requestAnimationFrame(tick);
        if (flameDirtyRef.current && selectedIdRef.current) {
          flameDirtyRef.current = false;
          redrawSelected(selectedIdRef.current);
        }
      };
      rafId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafId);
    }, [activeTab, redrawSelected]);

    // Redraw flamegraph when detail tab switches to flame
    useEffect(() => {
      if (detailTab === 'flame' && selectedId) redrawSelected(selectedId);
    }, [detailTab, selectedId, redrawSelected]);

    // ── Flamegraph hover tooltip ─────────────────────────────────────────
    useEffect(() => {
      const canvas = flameCanvasRef.current;
      const tip    = flameTipRef.current;
      if (!canvas || !tip) return;

      const onMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const cssY = e.clientY - rect.top;
        const hit  = flameHitTestRef.current(cssX, cssY);
        if (!hit) { tip.style.display = 'none'; return; }
        const { span, relStartMs } = hit;
        const isErr  = span.status === 'error';
        const statusColor = isErr ? '#f87171' : '#34d399';
        tip.innerHTML = [
          `<div class="fg-tip-name">${span.name}</div>`,
          `<div class="fg-tip-row"><span class="fg-tip-label">Target</span><span class="fg-tip-mono">${span.target}</span></div>`,
          span.service_name ? `<div class="fg-tip-row"><span class="fg-tip-label">Service</span><span class="fg-tip-mono">${span.service_name}</span></div>` : '',
          `<div class="fg-tip-row"><span class="fg-tip-label">Duration</span><span class="fg-tip-mono">${fmtDur(span.duration_ms)}</span></div>`,
          `<div class="fg-tip-row"><span class="fg-tip-label">Start +</span><span class="fg-tip-mono">${fmtDur(relStartMs)}</span></div>`,
          `<div class="fg-tip-row"><span class="fg-tip-label">Status</span><span class="fg-tip-mono" style="color:${statusColor}">${span.status || 'unset'}</span></div>`,
        ].join('');
        // Position near cursor, shifted to stay in viewport
        const pad = 14;
        let tx = e.clientX + pad;
        let ty = e.clientY + pad;
        tip.style.display = 'block';
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
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
    }, []);

    // ── Mermaid diagram ──────────────────────────────────────────────────
    const renderMermaid = useCallback(async () => {
      mermaidDirtyRef.current = false;
      const inner = mermaidInnerRef.current;
      if (!inner) return;
      const diagram = buildMermaidSrc(getEdges(), getLayoutNodes());
      if (!diagram) {
        inner.innerHTML = '<div id="trc-mermaid-empty">no topology data yet</div>';
        if (trcMmRef.current) trcMmRef.current.style.display = 'none';
        return;
      }
      const mermaid = (window as typeof window & { mermaid?: { initialize: (opts: object) => void; render: (id: string, src: string) => Promise<{svg: string}> } }).mermaid;
      if (!mermaid) { inner.innerHTML = '<div id="trc-mermaid-empty">mermaid not loaded</div>'; return; }
      try {
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
        const uid = 'trc-diagram-' + Date.now();
        const { svg } = await mermaid.render(uid, diagram);
        inner.innerHTML = svg;
        mmZoomRef.current = 1; mmPanRef.current = { x: 12, y: 12 };
        requestAnimationFrame(() => { mmFit(); requestAnimationFrame(() => updateMmThumbnail()); });
        highlightMermaidNodes();
      } catch (err) {
        console.warn('[traces] mermaid render failed', err);
        inner.innerHTML = `<pre style="color:${C.error};font-size:10px;white-space:pre-wrap">${escHtml(String(diagram))}</pre>`;
      }
    }, [getEdges, getLayoutNodes]);

    useEffect(() => {
      if (activeTab === 'traces' && mermaidDirtyRef.current) renderMermaid();
    }, [activeTab, renderMermaid]);

    // ── Mermaid pan/zoom helpers ─────────────────────────────────────────
    const applyMmTransform = useCallback(() => {
      const inner = mermaidInnerRef.current;
      if (!inner) return;
      const { x, y } = mmPanRef.current;
      inner.style.transform = `translate(${x}px,${y}px) scale(${mmZoomRef.current})`;
      setMmZoomPct(Math.round(mmZoomRef.current * 100));
      updateMmViewport();
    }, []);

    const getMmLayout = useCallback(() => {
      const inner = mermaidInnerRef.current;
      const cont  = mermaidContRef.current;
      if (!inner || !cont) return null;
      const r    = inner.getBoundingClientRect();
      const natW = r.width  / mmZoomRef.current;
      const natH = r.height / mmZoomRef.current;
      if (natW < 2 || natH < 2) return null;
      const mmScale = Math.min(TRC_MM_W / natW, TRC_MM_H / natH);
      return { mmScale, dx: (TRC_MM_W - natW * mmScale) / 2, dy: (TRC_MM_H - natH * mmScale) / 2, natW, natH };
    }, []);

    const updateMmViewport = useCallback(() => {
      const layout = getMmLayout();
      const mm     = trcMmRef.current;
      const vp     = trcMmVpRef.current;
      const cont   = mermaidContRef.current;
      if (!layout || !mm || !vp || !cont) { if (mm) mm.style.display = 'none'; return; }
      mm.style.display = 'block';
      const { mmScale, dx, dy } = layout;
      const cW  = cont.clientWidth;
      const cH  = cont.clientHeight;
      const { x: px, y: py } = mmPanRef.current;
      const zoom = mmZoomRef.current;
      vp.style.left   = `${dx + (-px / zoom) * mmScale}px`;
      vp.style.top    = `${dy + (-py / zoom) * mmScale}px`;
      vp.style.width  = `${(cW / zoom) * mmScale}px`;
      vp.style.height = `${(cH / zoom) * mmScale}px`;
    }, [getMmLayout]);

    const updateMmThumbnail = useCallback(() => {
      const inner  = mermaidInnerRef.current;
      const mmCvs  = trcMmCanvasRef.current;
      if (!inner || !mmCvs) return;
      const layout = getMmLayout();
      if (!layout) return;
      const { mmScale, dx, dy, natW, natH } = layout;
      const svg   = inner.querySelector('svg') as SVGSVGElement | null;
      if (!svg) return;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width',  String(Math.round(natW)));
      clone.setAttribute('height', String(Math.round(natH)));
      // Remove inline style (e.g. max-width) so the image renders at the specified dimensions
      clone.removeAttribute('style');
      const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        const ctx = mmCvs.getContext('2d')!;
        ctx.clearRect(0, 0, TRC_MM_W, TRC_MM_H);
        ctx.drawImage(img, dx, dy, natW * mmScale, natH * mmScale);
        URL.revokeObjectURL(url);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }, [getMmLayout]);

    const mmClampPan = useCallback(() => {
      const inner = mermaidInnerRef.current;
      const cont  = mermaidContRef.current;
      if (!inner || !cont) return;
      const r      = inner.getBoundingClientRect();
      const cW     = cont.clientWidth;
      const cH     = cont.clientHeight;
      const margin = 40;
      mmPanRef.current.x = Math.min(cW - margin, Math.max(margin - r.width,  mmPanRef.current.x));
      mmPanRef.current.y = Math.min(cH - margin, Math.max(margin - r.height, mmPanRef.current.y));
    }, []);

    const mmFit = useCallback(() => {
      const inner = mermaidInnerRef.current;
      const cont  = mermaidContRef.current;
      if (!inner || !cont) return;
      const r    = inner.getBoundingClientRect();
      const natW = r.width  / mmZoomRef.current;
      const natH = r.height / mmZoomRef.current;
      if (natW < 2 || natH < 2) return;
      const cW = cont.clientWidth  - 24;
      const cH = cont.clientHeight - 24;
      mmZoomRef.current   = Math.min(1, Math.min(cW / natW, cH / natH));
      mmPanRef.current.x  = (cW - natW * mmZoomRef.current) / 2 + 12;
      mmPanRef.current.y  = (cH - natH * mmZoomRef.current) / 2 + 12;
      applyMmTransform();
    }, [applyMmTransform]);

    // Mermaid pan/zoom events
    useEffect(() => {
      const cont = mermaidContRef.current;
      if (!cont) return;

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const factor  = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const rect    = cont.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const newZoom = Math.max(0.1, Math.min(6, mmZoomRef.current * factor));
        mmPanRef.current.x = cx - (cx - mmPanRef.current.x) * (newZoom / mmZoomRef.current);
        mmPanRef.current.y = cy - (cy - mmPanRef.current.y) * (newZoom / mmZoomRef.current);
        mmZoomRef.current  = newZoom;
        applyMmTransform();
      };
      cont.addEventListener('wheel', onWheel, { passive: false });

      let dragging = false;
      let dx0 = 0, dy0 = 0, px0 = 0, py0 = 0;
      const onMousedown = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('.trc-zoom-btn, #trc-mm')) return;
        dragging = true;
        dx0 = e.clientX; dy0 = e.clientY;
        px0 = mmPanRef.current.x; py0 = mmPanRef.current.y;
        cont.classList.add('dragging');
      };
      const onMousemove = (e: MouseEvent) => {
        if (!dragging) return;
        mmPanRef.current.x = px0 + (e.clientX - dx0);
        mmPanRef.current.y = py0 + (e.clientY - dy0);
        applyMmTransform();
      };
      const onMouseup = () => {
        if (!dragging) return;
        dragging = false;
        cont.classList.remove('dragging');
        mmClampPan();
        applyMmTransform();
      };
      cont.addEventListener('mousedown', onMousedown);
      window.addEventListener('mousemove', onMousemove);
      window.addEventListener('mouseup',   onMouseup);

      return () => {
        cont.removeEventListener('wheel', onWheel);
        cont.removeEventListener('mousedown', onMousedown);
        window.removeEventListener('mousemove', onMousemove);
        window.removeEventListener('mouseup',   onMouseup);
      };
    }, [applyMmTransform, mmClampPan]);

    // Keyboard nav: arrow keys through trace list
    useEffect(() => {
      const onKeydown = (e: KeyboardEvent) => {
        if (activeTab !== 'traces') return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        if (e.key === 'Escape') {
          if (selectedIdRef.current) { e.preventDefault(); selectTrace(selectedIdRef.current); }
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();

        const current = tracesRef.current;
        if (current.length === 0) return;
        const idx = selectedIdRef.current ? current.findIndex(t => t.trace_id === selectedIdRef.current) : -1;
        const next = e.key === 'ArrowDown'
          ? (idx === -1 ? 0 : Math.min(idx + 1, current.length - 1))
          : (idx === -1 ? current.length - 1 : Math.max(idx - 1, 0));
        selectTrace(current[next].trace_id);
      };
      document.addEventListener('keydown', onKeydown);
      return () => document.removeEventListener('keydown', onKeydown);
    }, [activeTab, selectTrace]);

    // ── Export selected trace ────────────────────────────────────────────
    const handleExport = useCallback(() => {
      const trace = tracesRef.current.find(t => t.trace_id === selectedIdRef.current);
      if (!trace) return;
      const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `trace-${trace.trace_id.slice(-12)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, []);

    // ── Derived render data ──────────────────────────────────────────────
    // Prefer tracesRef (always up-to-date) over React state to avoid the brief
    // window where inFlightSpans is already deleted but setTraces hasn't re-rendered.
    const selectedTrace = tracesRef.current.find(t => t.trace_id === selectedId)
      ?? traces.find(t => t.trace_id === selectedId);
    const selectedSpans: SpanEvent[] = selectedTrace
      ? selectedTrace.spans
      : (selectedId ? inFlightSpans.get(selectedId) ?? [] : []);
    const filteredSpans  = filterSpans(selectedSpans);
    const hiddenCount    = selectedSpans.length - filteredSpans.length;
    const visibleCount   = filteredSpans.length;
    const sortedSpans    = [...selectedSpans].sort((a, b) => a.start_time_unix_nano - b.start_time_unix_nano);
    const tMin           = sortedSpans[0]?.start_time_unix_nano ?? 0;
    const visibleIds     = new Set(filteredSpans.map(s => s.span_id));
    const filteredDepths = calcDepths(filteredSpans);
    const allDepths      = (showHidden && hiddenCount > 0) ? calcDepths(selectedSpans) : filteredDepths;
    const detailTitle = selectedId
      ? (() => {
          const root       = sortedSpans.find(s => !s.parent_span_id);
          const durationMs = selectedTrace
            ? selectedTrace.duration_ms
            : (sortedSpans.length > 0
                ? (sortedSpans.reduce((m, s) => Math.max(m, s.end_time_unix_nano), 0) - tMin) / 1_000_000
                : 0);
          const suffix  = selectedTrace ? '' : ' ⋯';
          const shortId = selectedId.slice(-12);
          const hiddenSuffix = hiddenCount > 0 ? ` (${hiddenCount} hidden)` : '';
          return `${root?.name || '⋯'} · ${fmtDur(durationMs)} · ${visibleCount} span${visibleCount !== 1 ? 's' : ''}${hiddenSuffix} · …${shortId}${suffix}`;
        })()
      : '';

    return (
      <div id="traces-view">
        {/* Left: trace list */}
        <div id="trc-list-panel">
          <div id="trc-list-header">
            <span>Traces</span>
            <span id="trc-list-count">{traces.length}</span>
            {listFrozen && <span id="trc-list-frozen">&#9646;&#9646; frozen</span>}
          </div>
          {selectedId && (() => {
            const pinned = tracesRef.current.find(t => t.trace_id === selectedId)
              ?? traces.find(t => t.trace_id === selectedId);
            if (!pinned) return null;
            const filtered    = filterSpans(pinned.spans);
            const rootSpan    = pinned.spans.find(s => !s.parent_span_id);
            const displayName = (rootSpan && !isSpanHidden(rootSpan))
              ? rootSpan.name
              : (filtered[0]?.name ?? pinned.root_span_name);
            const spanCount   = filtered.length;
            return (
              <div id="trc-pinned">
                <div id="trc-pinned-header">
                  <span id="trc-pinned-label">&#x1F4CD; Selected</span>
                  <button
                    id="trc-pinned-close"
                    title="Deselect trace"
                    onClick={() => selectTrace(pinned.trace_id)}
                  >✕</button>
                </div>
                <div className="trc-item trc-selected">
                  <div className="trc-item-id">&#8230;{pinned.trace_id.slice(-12)}</div>
                  <div className="trc-item-root">{displayName}</div>
                  <div className="trc-item-meta">
                    <span className="trc-item-dur">{fmtDur(pinned.duration_ms)}</span>
                    <span className="trc-item-cnt">{spanCount} span{spanCount !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              </div>
            );
          })()}
          <div
            id="trc-list-items"
            onMouseEnter={() => {
              frozenTracesRef.current = tracesRef.current.filter(t => t.trace_id !== selectedIdRef.current);
              setListFrozen(true);
            }}
            onMouseLeave={() => setListFrozen(false)}
            className={listFrozen ? 'trc-list-frozen' : undefined}
          >
            {(listFrozen ? frozenTracesRef.current : traces)
              .filter(t => t.trace_id !== selectedId)
              .map(trace => {
              const filtered   = filterSpans(trace.spans);
              const rootSpan   = trace.spans.find(s => !s.parent_span_id);
              const displayName = (rootSpan && !isSpanHidden(rootSpan))
                ? rootSpan.name
                : (filtered[0]?.name ?? trace.root_span_name);
              const spanCount  = filtered.length;
              return (
                <div
                  key={trace.trace_id}
                  className="trc-item"
                  onClick={() => selectTrace(trace.trace_id)}
                >
                  <div className="trc-item-id">&#8230;{trace.trace_id.slice(-12)}</div>
                  <div className="trc-item-root">{displayName}</div>
                  <div className="trc-item-meta">
                    <span className="trc-item-dur">{fmtDur(trace.duration_ms)}</span>
                    <span className="trc-item-cnt">{spanCount} span{spanCount !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: flamegraph + mermaid */}
        <div id="trc-right">
          <div id="trc-flame-wrap">
            <div id="trc-detail-tabs">
              <button
                className={`trc-dtab${detailTab === 'flame' ? ' trc-dtab-active' : ''}`}
                onClick={() => setDetailTab('flame')}
              >Flamegraph</button>
              <button
                className={`trc-dtab${detailTab === 'spans' ? ' trc-dtab-active' : ''}`}
                onClick={() => setDetailTab('spans')}
              >Spans</button>
              <span id="trc-detail-title">{detailTitle}</span>
              {selectedId && (
                <button id="trc-export" onClick={handleExport} title="Export selected trace as JSON">
                  &#8595; Export JSON
                </button>
              )}
            </div>

            {/* Flamegraph area */}
            <div id="trc-flame-area" className={detailTab === 'flame' ? 'trc-panel-active' : ''}>
              {!selectedId && <div id="trc-no-trace">&larr; select a trace to view its flamegraph</div>}
              <canvas ref={flameCanvasRef} id="trc-canvas" style={{ display: selectedId ? 'block' : 'none' }} />
            </div>
            {/* Flamegraph hover tooltip — positioned fixed, outside the scroll container */}
            <div ref={flameTipRef} id="fg-tip" style={{ display: 'none' }} />

            {/* Spans area */}
            <div id="trc-spans-area" className={detailTab === 'spans' ? 'trc-panel-active' : ''}>
              {!selectedId && <div id="trc-spans-no-trace">&larr; select a trace</div>}
              {selectedId && (
                <>
                  <div id="trc-spans-toolbar" style={{ display: 'flex' }}>
                    <label className="trc-show-hidden-label">
                      <input
                        type="checkbox"
                        id="trc-show-hidden"
                        checked={showHidden}
                        disabled={hiddenCount === 0}
                        onChange={e => setShowHidden(e.target.checked)}
                      />
                      <span id="trc-hidden-count-label">show hidden ({hiddenCount})</span>
                    </label>
                  </div>
                  <table id="trc-spans-table">
                    <thead>
                      <tr>
                        <th style={{ width: 52 }}>Depth</th>
                        <th>Span name</th>
                        <th>Target</th>
                        <th style={{ width: 80, textAlign: 'right' }}>Start</th>
                        <th style={{ width: 80, textAlign: 'right' }}>Duration</th>
                        <th style={{ width: 54 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSpans
                        .filter(s => visibleIds.has(s.span_id) || showHidden)
                        .map(s => {
                          const isHidden = !visibleIds.has(s.span_id);
                          const depth    = (isHidden ? allDepths : filteredDepths).get(s.span_id) ?? 0;
                          const col      = targetColor(s.target);
                          const relMs    = (s.start_time_unix_nano - tMin) / 1_000_000;
                          const isErr    = s.status === 'error';
                          return (
                            <tr key={s.span_id} className={isHidden ? 'trc-sp-hidden' : undefined}>
                              <td style={{ color: C.dim }}>{depth}</td>
                              <td className="trc-sp-name" style={{ paddingLeft: 8 + depth * 12 }}>{s.name}</td>
                              <td className="trc-sp-target" style={{ color: col.fill }}>{s.target}</td>
                              <td className="trc-sp-dur" style={{ color: C.dim }}>+{fmtDur(relMs)}</td>
                              <td className="trc-sp-dur">{fmtDur(s.duration_ms)}</td>
                              <td className={isErr ? 'trc-sp-err' : 'trc-sp-ok'}>{isErr ? 'error' : 'ok'}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>

          {/* Component diagram (mermaid) */}
          <div id="trc-mermaid-wrap">
            <div className="trc-panel-header">
              <span className="trc-panel-label">Component Diagram</span>
              <span id="trc-mermaid-hint">all services · cumulative · <span id="trc-zoom-pct">{mmZoomPct}%</span></span>
            </div>
            <div ref={mermaidContRef} id="trc-mermaid">
              <div ref={mermaidInnerRef} id="trc-mermaid-inner" />
              <div ref={trcMmRef} id="trc-mm">
                <canvas ref={trcMmCanvasRef} id="trc-mm-canvas" width={TRC_MM_W} height={TRC_MM_H} />
                <div ref={trcMmVpRef} id="trc-mm-viewport" />
              </div>
              <div id="trc-zoom-btns">
                <button className="trc-zoom-btn" title="Zoom in"
                  onClick={() => { mmZoomRef.current = Math.min(6, mmZoomRef.current * 1.3); applyMmTransform(); }}>+</button>
                <button className="trc-zoom-btn" title="Zoom out"
                  onClick={() => { mmZoomRef.current = Math.max(0.1, mmZoomRef.current / 1.3); applyMmTransform(); }}>−</button>
                <button className="trc-zoom-btn" title="Fit" style={{ fontSize: 9 }}
                  onClick={mmFit}>⊞</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

export default TracesPanel;
