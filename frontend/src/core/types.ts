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

export type MetricValue =
  | { kind: 'gauge';     value: number }
  | { kind: 'sum';       value: number; is_monotonic: boolean }
  | { kind: 'histogram'; count: number; sum: number; min: number; max: number };

export interface MetricEvent {
  service_name:        string;
  metric_name:         string;
  description:         string;
  unit:                string;
  timestamp_unix_nano: number;
  attributes:          [string, string][];
  value:               MetricValue;
}

export interface LogEvent {
  timestamp_unix_nano: number;
  observed_unix_nano:  number;
  severity_text:       string;
  severity_number:     number;
  body:                string;
  trace_id:            string | null;
  span_id:             string | null;
  attributes:          [string, string][];
  service_name:        string;
}

export type WsMessage =
  | { type: 'spans_batch';   spans:   SpanEvent[] }
  | { type: 'metrics_batch'; metrics: MetricEvent[] }
  | { type: 'logs_batch';    logs:    LogEvent[] };

export interface TraceBounds {
  min_started_at: number;
  max_started_at: number;
  count: number;
}
