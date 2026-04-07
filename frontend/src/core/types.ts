// ── Types ────────────────────────────────────────────────────────────────────

export interface SpanEvent {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  target: string;
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  duration_ms: number;
  attributes: [string, string][];
  status: string;
  service_name: string;
  instance_id?: string;
}

export interface Node {
  id: string;
  label: string;
  category: string;
  span_count: number;
}

export interface Edge {
  source: string;
  target: string;
  flow_count: number;
}

export interface TraceComplete {
  trace_id: string;
  spans: SpanEvent[];
  root_span_name: string;
  duration_ms: number;
  started_at: number;
  instance_id: string;
}

export type WsMessage =
  | { type: 'spans_batch'; spans: SpanEvent[] };

export interface TraceBounds {
  min_started_at: number;
  max_started_at: number;
  count: number;
}
