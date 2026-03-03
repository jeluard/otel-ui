// ── useHistoryPlayback — history mode state + playback loop ───────────────────

import { useState, useRef, useCallback, useEffect } from 'react';

import { fetchBounds, fetchTraces } from '../core/history-client.ts';
import { generateDemoHistoryTraces } from '../core/demo.ts';
import type { TraceComplete, TraceBounds } from '../core/types.ts';

export interface HistoryRange {
  from: number; // nanoseconds (started_at units)
  to:   number;
}

export interface HistoryFilters {
  service:        string;
  minDurationMs:  string;
  maxDurationMs:  string;
}

const DEFAULT_FILTERS: HistoryFilters = { service: '', minDurationMs: '', maxDurationMs: '' };

export interface HistoryPlayback {
  historyEnabled:  boolean;
  toggleHistory:   () => void;

  bounds:          TraceBounds | null;
  range:           HistoryRange;
  setRange:        (r: HistoryRange) => void;

  filters:         HistoryFilters;
  setFilters:      (f: HistoryFilters) => void;

  traces:          TraceComplete[];
  isLoading:       boolean;
  loadTraces:      () => Promise<void>;

  /** Index of the last visible trace (-1 = before all traces). */
  cursorIndex:     number;
  cursorIndexRef:  React.MutableRefObject<number>;
  /** Nanosecond timestamp of the current cursor position (drives RAF loop in App). */
  cursorNs:        number;
  setCursorNs:     (ns: number) => void;
  cursorRef:       React.MutableRefObject<number>;

  playing:         boolean;
  play:            () => void;
  pause:           () => void;
  reset:           () => void;
  stepBack:        () => void;
  stepForward:     () => void;
  stepTo:          (index: number) => void;
}

export function useHistoryPlayback(demoMode = false): HistoryPlayback {
  const demoModeRef = useRef(demoMode);
  useEffect(() => { demoModeRef.current = demoMode; }, [demoMode]);
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [bounds, setBounds]   = useState<TraceBounds | null>(null);
  const [range, setRangeState] = useState<HistoryRange>({ from: 0, to: 0 });
  const [filters, setFiltersState] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [traces, setTraces]   = useState<TraceComplete[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [cursorNs, setCursorNsState] = useState(0);
  const [cursorIndex, setCursorIndexState] = useState(-1);
  const [playing, setPlaying] = useState(false);

  // Mutable refs
  const cursorRef      = useRef(0);
  const cursorIndexRef = useRef(-1);
  const tracesRef      = useRef<TraceComplete[]>([]);
  const rangeRef       = useRef<HistoryRange>({ from: 0, to: 0 });
  const filtersRef     = useRef<HistoryFilters>(DEFAULT_FILTERS);

  const setCursorNs = useCallback((ns: number) => {
    cursorRef.current = ns;
    setCursorNsState(ns);
  }, []);

  const setRange = useCallback((r: HistoryRange) => {
    rangeRef.current = r;
    setRangeState(r);
  }, []);

  const setFilters = useCallback((f: HistoryFilters) => {
    filtersRef.current = f;
    setFiltersState(f);
  }, []);

  /** Move cursor to a specific trace index (clamped). Does not affect playing state. */
  const stepTo = useCallback((idx: number) => {
    const t = tracesRef.current;
    const clamped = Math.max(-1, Math.min(t.length - 1, idx));
    const ns = clamped >= 0 ? t[clamped].started_at : rangeRef.current.from;
    cursorIndexRef.current = clamped;
    setCursorIndexState(clamped);
    cursorRef.current = ns;
    setCursorNsState(ns);
  }, []);

  const toggleHistory = useCallback(() => {
    setHistoryEnabled(prev => {
      if (!prev) {
        if (demoModeRef.current) {
          // Demo mode: synthesise a 5-minute window ending now
          const toNs   = Date.now() * 1_000_000;
          const fromNs = toNs - 5 * 60 * 1_000_000_000;
          const b: TraceBounds = { min_started_at: fromNs, max_started_at: toNs, count: 0 };
          setBounds(b);
          const r = { from: fromNs, to: toNs };
          rangeRef.current = r;
          setRangeState(r);
        } else {
          // Entering history: fetch bounds to pre-fill range
          fetchBounds().then(b => {
            if (b) {
              setBounds(b);
              const r = { from: b.min_started_at, to: b.max_started_at };
              rangeRef.current = r;
              setRangeState(r);
            }
          });
        }
      } else {
        // Exiting: stop playback
        setPlaying(false);
      }
      return !prev;
    });
  }, []);

  const loadTraces = useCallback(async () => {
    const r = rangeRef.current;
    if (!r.from && !r.to) return;
    setIsLoading(true);
    const f = filtersRef.current;
    try {
      let data: TraceComplete[];
      if (demoModeRef.current) {
        data = generateDemoHistoryTraces(r.from, r.to, 200);
      } else {
        data = await fetchTraces(r.from, r.to, 2000, {
          service:         f.service        || undefined,
          min_duration_ms: f.minDurationMs ? Number(f.minDurationMs) : undefined,
          max_duration_ms: f.maxDurationMs ? Number(f.maxDurationMs) : undefined,
        });
      }
      setTraces(data);
      tracesRef.current = data;
      // Reset cursor to before all traces
      cursorIndexRef.current = -1;
      setCursorIndexState(-1);
      cursorRef.current = r.from;
      setCursorNsState(r.from);
      setPlaying(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const play = useCallback(() => { setPlaying(true); }, []);
  const pause = useCallback(() => { setPlaying(false); }, []);
  const reset = useCallback(() => {
    setPlaying(false);
    const from = rangeRef.current.from;
    cursorIndexRef.current = -1;
    setCursorIndexState(-1);
    cursorRef.current = from;
    setCursorNsState(from);
  }, []);
  const stepBack    = useCallback(() => { stepTo(cursorIndexRef.current - 1); }, [stepTo]);
  const stepForward = useCallback(() => { stepTo(cursorIndexRef.current + 1); }, [stepTo]);

  // Check if history data exists on mount (without loading traces)
  useEffect(() => {
    if (demoModeRef.current) return; // Skip for demo mode

    const checkHistoryExists = async () => {
      try {
        const b = await fetchBounds();
        if (b && b.count > 0) {
          setBounds(b);
          const r = { from: b.min_started_at, to: b.max_started_at };
          rangeRef.current = r;
          setRangeState(r);
          // Don't load traces yet — user will click the history button to load
        }
      } catch (err) {
        console.warn('Failed to check history bounds:', err);
      }
    };

    checkHistoryExists();
  }, []);

  // Auto-play: advance one trace every 300ms
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const t   = tracesRef.current;
      const next = cursorIndexRef.current + 1;
      if (next >= t.length) {
        setPlaying(false);
      } else {
        const ns = t[next].started_at;
        cursorIndexRef.current = next;
        setCursorIndexState(next);
        cursorRef.current = ns;
        setCursorNsState(ns);
      }
    }, 300);
    return () => clearInterval(id);
  }, [playing]);

  return {
    historyEnabled, toggleHistory,
    bounds, range, setRange,
    filters, setFilters,
    traces, isLoading, loadTraces,
    cursorNs, setCursorNs, cursorRef,
    cursorIndex, cursorIndexRef,
    playing,
    play, pause, reset, stepBack, stepForward, stepTo,
  };
}
