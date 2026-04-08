// ── LogsView: live log stream ─────────────────────────────────────────────────

import React, {
  useState,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useEffect,
} from 'react';
import type { LogEvent } from '../core/types.ts';
import { fmtTime } from '../core/utils.ts';

// ── Public handle ─────────────────────────────────────────────────────────────

export interface LogsViewHandle {
  add(logs: LogEvent[]): void;
  clear(): void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_LOGS = 2000;

// ── Severity helpers ──────────────────────────────────────────────────────────

function sevClass(log: LogEvent): 'error' | 'warn' | 'info' | 'debug' {
  const t = log.severity_text.toLowerCase();
  const n = log.severity_number;
  if (t.includes('error') || t.includes('fatal') || n >= 17) return 'error';
  if (t.includes('warn')  || (n >= 13 && n <= 16))           return 'warn';
  if (t.includes('debug') || (n >= 1  && n <= 8))            return 'debug';
  return 'info';
}

function sevLabel(log: LogEvent): string {
  if (log.severity_text) return log.severity_text.toUpperCase().slice(0, 5);
  if (log.severity_number >= 21) return 'FATAL';
  if (log.severity_number >= 17) return 'ERROR';
  if (log.severity_number >= 13) return 'WARN';
  if (log.severity_number >= 9)  return 'INFO';
  if (log.severity_number >= 1)  return 'DEBUG';
  return 'LOG';
}

// ── Component ─────────────────────────────────────────────────────────────────

const LogsView = forwardRef<LogsViewHandle>(function LogsView(_props, ref) {
  const [logs, setLogs]           = useState<LogEvent[]>([]);
  const [filter, setFilter]       = useState('');
  const [sevFilter, setSevFilter] = useState<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
  const [paused, setPaused]       = useState(false);
  const [unread, setUnread]       = useState(0);
  const logsRef   = useRef<LogEvent[]>([]);
  const pausedRef = useRef(false);
  const bodyRef   = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Track scroll position to decide auto-scroll
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 32;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useImperativeHandle(ref, () => ({
    add(incoming: LogEvent[]) {
      const next = [...logsRef.current, ...incoming].slice(-MAX_LOGS);
      logsRef.current = next;
      if (pausedRef.current) {
        setUnread(u => u + incoming.length);
      } else {
        setLogs([...next]);
      }
    },
    clear() {
      logsRef.current = [];
      setLogs([]);
      setUnread(0);
    },
  }), []);

  const resume = useCallback(() => {
    setPaused(false);
    pausedRef.current = false;
    setLogs([...logsRef.current]);
    setUnread(0);
  }, []);

  // Auto-scroll on new logs
  useEffect(() => {
    if (!paused && atBottomRef.current) {
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logs, paused]);

  const filterLower = filter.toLowerCase();
  const visible = logs.filter(log => {
    if (sevFilter !== 'all' && sevClass(log) !== sevFilter) return false;
    if (filterLower && !log.body.toLowerCase().includes(filterLower) &&
        !log.service_name.toLowerCase().includes(filterLower) &&
        !(log.trace_id ?? '').includes(filterLower) &&
        !(log.span_id ?? '').includes(filterLower)) return false;
    return true;
  });

  return (
    <div id="logs-view">
      {/* Toolbar */}
      <div id="logs-toolbar">
        <input
          id="logs-filter"
          type="text"
          placeholder="Filter logs…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div id="logs-sev-btns">
          {(['all', 'debug', 'info', 'warn', 'error'] as const).map(s => (
            <button
              key={s}
              className={`logs-sev-btn logs-sev-${s}${sevFilter === s ? ' logs-sev-active' : ''}`}
              onClick={() => setSevFilter(s)}
            >{s.toUpperCase()}</button>
          ))}
        </div>
        <span id="logs-count">{visible.length} / {logs.length}</span>
        <button
          id="logs-pause-btn"
          className={paused ? 'logs-paused' : undefined}
          title={paused ? 'Resume live stream' : 'Pause live stream'}
          onClick={() => paused ? resume() : setPaused(true)}
        >
          {paused ? `▶ Resume${unread ? ` (${unread})` : ''}` : '⏸ Pause'}
        </button>
        <button
          id="logs-clear-btn"
          title="Clear all logs"
          onClick={() => { logsRef.current = []; setLogs([]); setUnread(0); }}
        >✕ Clear</button>
      </div>

      {/* Log rows */}
      <div id="logs-body" ref={bodyRef}>
        {visible.length === 0 && (
          <div id="logs-empty">
            {logs.length === 0
              ? 'No logs received yet. Send OTLP logs to the collector and they will appear here.'
              : 'No logs match the current filter.'}
          </div>
        )}
        {visible.map((log, i) => {
          const sc   = sevClass(log);
          return (
            <div key={i} className={`log-row log-row-${sc}`}>
              <span className="log-ts">{log.timestamp_unix_nano ? fmtTime(log.timestamp_unix_nano) : '—'}</span>
              <span className={`log-sev log-sev-${sc}`}>{sevLabel(log)}</span>
              <span className="log-svc">{log.service_name}</span>
              <span className="log-body">{log.body}</span>
              {log.trace_id && (
                <span className="log-trace-id" title={`trace: ${log.trace_id}`}>…{log.trace_id.slice(-8)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default LogsView;
