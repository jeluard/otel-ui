// ── Types matching the Rust backend WsMessage enum ──────────────────────────

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
}

export interface SpanArrivedPayload {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  target: string;
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  duration_ms: number;
  status: string;
  service_name: string;
  from_node: string | null;
  to_node: string;
  edge_latency_ms: number | null;
}

export type WsMessage =
  | { type: 'topology_snapshot'; nodes: Node[]; edges: Edge[] }
  | { type: 'spans_batch'; spans: SpanArrivedPayload[] }
  | { type: 'trace_completed'; trace: TraceComplete }
  | { type: 'topology_updated'; nodes: Node[]; edges: Edge[] }
  | { type: 'stats'; total_traces: number; spans_per_second: number; active_nodes: number; timestamp: number };
