// ── DiagramView: main canvas, minimap, tooltip, legend ────────────────────────
// Owns the frame loop for drawing. Span data processing lives in App.tsx;
// DiagramView reads from shared mutable refs (no React state for frame-loop data).

import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { initBackground, drawBackground } from '../canvas/background.ts';
import type { SharedState } from '../App.tsx';
import type { TabId } from '../App.tsx';
import { targetColor, getAssignedTargets } from '../core/colors.ts';
import { pctile, fmtDur } from '../core/utils.ts';
import { C } from '../core/theme.ts';

const MM_W = 180;
const MM_H = 120;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface DiagramViewHandle {}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  nodeId: string;
}

interface LegendEntry {
  target: string;
  color: { fill: string };
}

interface DiagramViewProps {
  sharedRef: React.MutableRefObject<SharedState>;
  activeTab: TabId;
  selectedNodeId: string | null;
  onNodeSelect: (id: string | null) => void;
}

const DiagramView = forwardRef<DiagramViewHandle, DiagramViewProps>(
  function DiagramView({ sharedRef, activeTab, selectedNodeId, onNodeSelect }, ref) {
    const bgCanvasRef   = useRef<HTMLCanvasElement>(null);
    const mainCanvasRef = useRef<HTMLCanvasElement>(null);
    const mmCanvasRef   = useRef<HTMLCanvasElement>(null);

    const [tooltip, setTooltip]       = useState<TooltipState>({ visible: false, x: 0, y: 0, nodeId: '' });
    const [legendEntries, setLegend]  = useState<LegendEntry[]>([]);

    // Keep refs to avoid stale closures in the frame loop
    const activeTabRef      = useRef(activeTab);
    const selectedNodeIdRef = useRef(selectedNodeId);
    useEffect(() => { activeTabRef.current = activeTab; },       [activeTab]);
    useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);

    // Interaction state refs (no React state → no re-render on every mousemove)
    const isPanningRef      = useRef(false);
    const panMovedRef       = useRef(false);
    const panStartRef       = useRef({ x: 0, y: 0 });
    const canvasMouseDownRef= useRef(false);
    const hoveredNodeIdRef  = useRef<string | null>(null);

    // ── Imperative handle (reserved for future use) ───────────────────────
    useImperativeHandle(ref, () => ({}));

    // ── Minimap draw helper ────────────────────────────────────────────────
    const drawMinimap = useCallback(() => {
      const mmCanvas = mmCanvasRef.current;
      const mainCanvas = mainCanvasRef.current;
      if (!mmCanvas || !mainCanvas) return;
      const mmCtx = mmCanvas.getContext('2d')!;
      const st = sharedRef.current;
      const nodes = Array.from(st.layout.nodes.values());

      if (nodes.length === 0) { mmCanvas.style.opacity = '0'; return; }
      mmCanvas.style.opacity = '1';

      mmCtx.clearRect(0, 0, MM_W, MM_H);
      mmCtx.fillStyle = C.minimapBg;
      mmCtx.fillRect(0, 0, MM_W, MM_H);
      mmCtx.strokeStyle = C.minimapBorder;
      mmCtx.lineWidth = 1;
      mmCtx.strokeRect(0.5, 0.5, MM_W - 1, MM_H - 1);

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x - n.radius); minY = Math.min(minY, n.y - n.radius);
        maxX = Math.max(maxX, n.x + n.radius); maxY = Math.max(maxY, n.y + n.radius);
      }
      const wW = Math.max(1, maxX - minX);
      const wH = Math.max(1, maxY - minY);
      const pad = 10;
      const mmScale = Math.min((MM_W - pad * 2) / wW, (MM_H - pad * 2) / wH);
      const toMm = (wx: number, wy: number) => ({ x: pad + (wx - minX) * mmScale, y: pad + (wy - minY) * mmScale });

      mmCtx.strokeStyle = C.minimapEdge; mmCtx.lineWidth = 0.8;
      for (const e of st.edges) {
        const src = st.layout.nodes.get(e.source); const tgt = st.layout.nodes.get(e.target);
        if (!src || !tgt) continue;
        const s = toMm(src.x, src.y), t = toMm(tgt.x, tgt.y);
        mmCtx.beginPath(); mmCtx.moveTo(s.x, s.y); mmCtx.lineTo(t.x, t.y); mmCtx.stroke();
      }
      for (const n of nodes) {
        const { x, y } = toMm(n.x, n.y);
        const r = Math.max(2.5, n.radius * mmScale);
        mmCtx.beginPath(); mmCtx.arc(x, y, r, 0, Math.PI * 2);
        mmCtx.fillStyle = targetColor(n.category).fill; mmCtx.fill();
      }

      const tl = st.camera.screenToWorld(0, 0);
      const br = st.camera.screenToWorld(mainCanvas.width, mainCanvas.height);
      const vpTl = toMm(tl.x, tl.y);
      const vpBr = toMm(br.x, br.y);
      mmCtx.strokeStyle = C.minimapVp; mmCtx.lineWidth = 1;
      mmCtx.strokeRect(vpTl.x, vpTl.y, Math.max(4, vpBr.x - vpTl.x), Math.max(4, vpBr.y - vpTl.y));
    }, [sharedRef]);

    // ── Show / hide tooltip ────────────────────────────────────────────────
    const showTooltip = useCallback((x: number, y: number, nodeId: string) => {
      setTooltip({ visible: true, x, y, nodeId });
    }, []);

    const hideTooltip = useCallback(() => {
      setTooltip(t => t.visible ? { ...t, visible: false } : t);
    }, []);

    // ── Canvas setup + frame loop ──────────────────────────────────────────
    useEffect(() => {
      const bgCanvas   = bgCanvasRef.current!;
      const mainCanvas = mainCanvasRef.current!;
      const st         = sharedRef.current;

      const resize = () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        bgCanvas.width = mainCanvas.width  = w;
        bgCanvas.height = mainCanvas.height = h;
        st.layout.resize(w, h);
        st.layout.unsettle();
        st.renderer.invalidateGuides();
        initBackground(w, h);
      };
      resize();
      window.addEventListener('resize', resize);

      const bgCtx   = bgCanvas.getContext('2d')!;
      const ctx      = mainCanvas.getContext('2d')!;

      let lastTime = performance.now();
      let mmTick   = 0;
      let rafId: number;

      const frame = (now: number) => {
        rafId = requestAnimationFrame(frame);
        const dt = Math.min(now - lastTime, 48);
        lastTime = now;

        for (const [id, exp] of st.activeExpiry) {
          if (exp <= now) st.activeExpiry.delete(id);
        }

        if (activeTabRef.current === 'diagram') {
          drawBackground(bgCtx, bgCanvas.width, bgCanvas.height, dt, now);
          st.layout.tick(st.edges, st.serverEdges);

          const diagramActive =
            !st.layout.isSettled      ||
            st.activeExpiry.size > 0  ||
            hoveredNodeIdRef.current !== null ||
            st.renderer.hasActiveAnimations(now);

          if (diagramActive || (mmTick % 4) === 0) {
            ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
            ctx.save();
            st.camera.applyTo(ctx);
            st.renderer.drawColumnGuides(ctx, st.layout.nodes, mainCanvas.height / st.camera.scale, 92 / st.camera.scale);
            const diagHL = st.traceHL ?? st.selectionHL;
            st.renderer.drawEdges(ctx, st.edges, st.layout.nodes, now, diagHL?.edgeKeys);
            st.renderer.drawNodes(ctx, st.layout.nodes, hoveredNodeIdRef.current, st.activeExpiry, now, diagHL?.nodes, selectedNodeIdRef.current);
            ctx.restore();
          }
          if ((mmTick++ % 3) === 0) drawMinimap();
        }
      };

      rafId = requestAnimationFrame(frame);
      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', resize);
      };
    }, [sharedRef, drawMinimap]);

    // ── Refresh legend when topology changes ───────────────────────────────
    // Poll inside the frame loop via an interval so we never set state in a
    // dependency-free useEffect (which would loop on every render).
    useEffect(() => {
      const id = setInterval(() => {
        const entries = getAssignedTargets();
        setLegend(prev => {
          const prevTargets = prev.map(e => e.target).join(',');
          const nextTargets = entries.map(e => e.target).join(',');
          if (prevTargets === nextTargets) return prev;
          return entries.map(e => ({ target: e.target, color: { fill: e.color.fill } }));
        });
      }, 1000);
      return () => clearInterval(id);
    }, []);

    // ── Mouse event handlers ───────────────────────────────────────────────
    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
      if (e.target !== mainCanvasRef.current) return;
      canvasMouseDownRef.current = true;
      const st = sharedRef.current;
      const world = st.camera.screenToWorld(e.clientX, e.clientY);
      const hit   = st.renderer.hitTest(world.x, world.y, st.layout.nodes);
      if (e.button === 0 && !hit) {
        isPanningRef.current = true;
        panMovedRef.current  = false;
        panStartRef.current  = { x: e.clientX, y: e.clientY };
        (e.target as HTMLCanvasElement).style.cursor = 'grabbing';
      }
    }, [sharedRef]);

    const handleMouseUp = useCallback((e: MouseEvent) => {
      const didPan     = isPanningRef.current && panMovedRef.current;
      const fromCanvas = canvasMouseDownRef.current;
      canvasMouseDownRef.current = false;
      panMovedRef.current        = false;
      if (isPanningRef.current) {
        isPanningRef.current = false;
        if (mainCanvasRef.current)
          mainCanvasRef.current.style.cursor = hoveredNodeIdRef.current ? 'pointer' : 'default';
      }
      if (!didPan && e.button === 0 && fromCanvas) {
        const st    = sharedRef.current;
        const world = st.camera.screenToWorld(e.clientX, e.clientY);
        const hit   = st.renderer.hitTest(world.x, world.y, st.layout.nodes);
        if (hit) {
          onNodeSelect(hit);
        } else if (selectedNodeIdRef.current) {
          onNodeSelect(null);
        }
      }
    }, [sharedRef, onNodeSelect]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
      const st = sharedRef.current;
      if (isPanningRef.current) {
        panMovedRef.current = true;
        st.camera.pan(e.clientX - panStartRef.current.x, e.clientY - panStartRef.current.y);
        panStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
      const world = st.camera.screenToWorld(e.clientX, e.clientY);
      const hit   = st.renderer.hitTest(world.x, world.y, st.layout.nodes);
      hoveredNodeIdRef.current = hit;
      if (mainCanvasRef.current) mainCanvasRef.current.style.cursor = hit ? 'pointer' : 'default';
      if (hit && !selectedNodeIdRef.current) showTooltip(e.clientX, e.clientY, hit);
      else hideTooltip();
    }, [sharedRef, showTooltip, hideTooltip]);

    const handleWheel = useCallback((e: WheelEvent) => {
      e.preventDefault();
      const lineH  = 16;
      const pageH  = window.innerHeight;
      const pixels = e.deltaMode === 1 ? e.deltaY * lineH : e.deltaMode === 2 ? e.deltaY * pageH : e.deltaY;
      sharedRef.current.camera.zoomAt(e.clientX, e.clientY, Math.pow(0.997, pixels));
    }, [sharedRef]);

    const handleDblClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
      const st    = sharedRef.current;
      const world = st.camera.screenToWorld(e.clientX, e.clientY);
      const hit   = st.renderer.hitTest(world.x, world.y, st.layout.nodes);
      if (!hit && !selectedNodeIdRef.current) st.camera.reset();
    }, [sharedRef]);

    // Attach window-level listeners (mouseup, mousemove, wheel) after mount
    useEffect(() => {
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('mousemove', handleMouseMove);
      const canvas = mainCanvasRef.current;
      if (canvas) canvas.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        window.removeEventListener('mouseup', handleMouseUp);
        window.removeEventListener('mousemove', handleMouseMove);
        if (canvas) canvas.removeEventListener('wheel', handleWheel);
      };
    }, [handleMouseUp, handleMouseMove, handleWheel]);

    // ── Tooltip content from current node data ─────────────────────────────
    const renderTooltipContent = () => {
      if (!tooltip.visible) return null;
      const st   = sharedRef.current;
      const node = st.layout.nodes.get(tooltip.nodeId);
      if (!node) return null;
      const col     = targetColor(node.category).fill;
      const spans   = st.nodeSpans.get(tooltip.nodeId) ?? [];
      const sorted  = spans.map(s => s.duration_ms).filter(d => d > 0).sort((a, b) => a - b);
      const ttP50   = sorted.length >= 3  ? pctile(sorted, 0.50) : null;
      const ttP95   = sorted.length >= 10 ? pctile(sorted, 0.95) : null;
      const tw      = 260;
      let tx = tooltip.x + 16;
      let ty = tooltip.y - 10;
      if (tx + tw > window.innerWidth - 280) tx = tooltip.x - tw - 16;
      if (ty < 100) ty = tooltip.y + 20;

      return (
        <div id="tooltip" style={{ left: tx, top: ty, opacity: 1 }}>
          <div className="tooltip-title">{node.label}</div>
          <div>
            <div className="tooltip-row"><span>Span</span><span>{node.id}</span></div>
            <div className="tooltip-row"><span>Target</span><span>{node.category}</span></div>
            <div className="tooltip-row"><span>Spans seen</span><span>{node.span_count}</span></div>
            {ttP50 != null && (
              <div className="tooltip-row">
                <span>P50 dur</span>
                <span style={{ color: C.cyan }}>{fmtDur(ttP50)}</span>
              </div>
            )}
            {ttP95 != null && (
              <div className="tooltip-row">
                <span>P95 dur</span>
                <span style={{ color: C.amber }}>{fmtDur(ttP95)}</span>
              </div>
            )}
            <span className="tooltip-tag" style={{ background: `${col}22`, color: col, border: `1px solid ${col}44` }}>
              {node.category}
            </span>
          </div>
        </div>
      );
    };

    return (
      <>
        <canvas ref={bgCanvasRef}   id="bg-canvas" />
        <canvas
          ref={mainCanvasRef}
          id="main-canvas"
          onMouseDown={handleMouseDown}
          onMouseLeave={() => { hoveredNodeIdRef.current = null; hideTooltip(); }}
          onDoubleClick={handleDblClick}
        />
        <canvas ref={mmCanvasRef} id="minimap" width={MM_W} height={MM_H} />
        <div id="zoom-hint">scroll → zoom · drag → pan · dbl-click → reset</div>

        {/* Tooltip */}
        {tooltip.visible && renderTooltipContent()}
        {!tooltip.visible && <div id="tooltip" style={{ opacity: 0 }} />}

        {/* Legend */}
        <div id="legend">
          <div className="legend-title">Target</div>
          {legendEntries.length === 0 ? (
            <div className="legend-item" style={{ color: C.muted }}>no data yet</div>
          ) : (
            legendEntries.map(({ target, color }) => (
              <div key={target} className="legend-item">
                <div
                  className="legend-dot"
                  style={{ background: color.fill, boxShadow: `0 0 5px ${color.fill}66` }}
                />
                {target}
              </div>
            ))
          )}
        </div>
      </>
    );
  },
);

export default DiagramView;
