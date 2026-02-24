// ── SpansView: live spans table ───────────────────────────────────────────────
// Wraps the performance-critical TracesTable class in a React component.
// The table manipulates its tbody directly for high-frequency updates (200+/frame).
// React manages the shell, filter bar, and column structure.

import React, {
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { TracesTable } from '../panels/traces-table.ts';
import type { SpanEvent } from '../core/types.ts';

interface SpansViewProps {
  lookupFullSpan?: (spanId: string) => SpanEvent | undefined;
}

export interface SpansViewHandle {
  add(span: SpanEvent, tabVisible: boolean): void;
  enrich(spans: SpanEvent[]): void;
  clearUnread(): void;
}

const SpansView = forwardRef<SpansViewHandle, SpansViewProps>(
  function SpansView({ lookupFullSpan }, ref) {
    const tbodyRef          = useRef<HTMLTableSectionElement>(null);
    const wrapRef           = useRef<HTMLDivElement>(null);
    const countRef          = useRef<HTMLSpanElement>(null);
    const emptyRef          = useRef<HTMLDivElement>(null);
    const targetWrapRef     = useRef<HTMLDivElement>(null);
    const nameWrapRef       = useRef<HTMLDivElement>(null);
    const durMinRef         = useRef<HTMLInputElement>(null);
    const durMaxRef         = useRef<HTMLInputElement>(null);
    const clearBtnRef       = useRef<HTMLButtonElement>(null);
    const matchRef          = useRef<HTMLSpanElement>(null);
    const detailPanelRef    = useRef<HTMLDivElement>(null);

    const tableRef = useRef<TracesTable | null>(null);

    useEffect(() => {
      if (!tbodyRef.current) return;
      tableRef.current = new TracesTable({
        tbody:            tbodyRef.current,
        wrap:             wrapRef.current!,
        countEl:          countRef.current!,
        emptyEl:          emptyRef.current!,
        filterTargetWrap: targetWrapRef.current!,
        filterNameWrap:   nameWrapRef.current!,
        filterDurMin:     durMinRef.current!,
        filterDurMax:     durMaxRef.current!,
        filterClear:      clearBtnRef.current!,
        filterMatch:      matchRef.current!,
        detailPanel:      detailPanelRef.current!,
        lookupFullSpan,
      });
    }, []);

    useImperativeHandle(ref, () => ({
      add:        (span, tabVisible) => tableRef.current?.add(span, tabVisible),
      enrich:     (spans)            => tableRef.current?.enrich(spans),
      clearUnread:()                 => tableRef.current?.clearUnread(),
    }));

    return (
      <div id="spans-view">
        {/* Filter bar */}
        <div id="spans-filter-bar">
          <div className="filter-group">
            <label>Target</label>
            <div ref={targetWrapRef} className="ms-wrap" />
          </div>
          <div className="filter-group">
            <label>Span name</label>
            <div ref={nameWrapRef} className="ms-wrap" />
          </div>
          <div className="filter-group">
            <label htmlFor="f-dur-min">Duration ≥</label>
            <input ref={durMinRef} id="f-dur-min" className="filter-input filter-input-short" type="number" placeholder="0" min="0" step="1" />
            <span className="filter-unit">ms</span>
          </div>
          <div className="filter-group">
            <label htmlFor="f-dur-max">≤</label>
            <input ref={durMaxRef} id="f-dur-max" className="filter-input filter-input-short" type="number" placeholder="∞" min="0" step="1" />
            <span className="filter-unit">ms</span>
          </div>
          <button ref={clearBtnRef}>✕ Clear</button>
          <span ref={matchRef} id="f-match" />
        </div>

        {/* Table + detail drawer */}
        <div id="spans-body">
          <div ref={wrapRef} id="spans-wrap">
            <table id="spans-table">
              <colgroup>
                <col className="c-time" />
                <col className="c-trace" />
                <col className="c-name" />
                <col className="c-target" />
                <col className="c-dur" />
              </colgroup>
              <thead>
                <tr>
                  <th className="c-time">Time</th>
                  <th className="c-trace">Trace</th>
                  <th className="c-name">Span name</th>
                  <th className="c-target">Target</th>
                  <th className="c-dur" style={{ textAlign: 'right' }}>Duration</th>
                </tr>
              </thead>
              <tbody ref={tbodyRef} />
            </table>
            <div ref={emptyRef} id="spans-empty">
              <div className="hint-icon">⬡</div>
              <div className="hint-title">No spans yet</div>
              <div className="hint-sub">Spans will appear here as they arrive</div>
            </div>
          </div>
          <div ref={detailPanelRef} id="span-detail" />
        </div>

        <div id="spans-footer">
          <span ref={countRef} id="spans-count">0 spans</span>
          <span style={{ color: '#334155' }}>·</span>
          <span style={{ color: '#1e293b' }}>newest first · max 500 rows · click row for details</span>
        </div>
      </div>
    );
  },
);

export default SpansView;
