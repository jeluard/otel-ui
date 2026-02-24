use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// A node/component discovered from spans (keyed by the `target` field of a span).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub category: String, // "network", "consensus", "ledger", "store", "protocol"
    pub span_count: u64,
}

/// A directed edge between two components, discovered from trace causality.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub flow_count: u64,
}

/// Payload for a single span-arrived event; carried inside a `SpansBatch`.
/// Attributes are intentionally omitted — they are large and the real-time
/// UI only needs the fields below. Full spans (with attrs) live in `in_flight`
/// until the trace is finalised.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanArrivedPayload {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub target: String,
    pub start_time_unix_nano: u64,
    pub end_time_unix_nano: u64,
    pub duration_ms: f64,
    pub status: String,
    pub service_name: String,
    /// Source node id (parent's target)
    pub from_node: Option<String>,
    /// Destination node id
    pub to_node: String,
    /// Delay from parent span start to this span's start (ms); None if no parent known
    pub edge_latency_ms: Option<f64>,
}

/// A single span decoded from OTLP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanEvent {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub target: String,
    pub start_time_unix_nano: u64,
    pub end_time_unix_nano: u64,
    pub duration_ms: f64,
    pub attributes: Vec<(String, String)>,
    pub status: String,
    pub service_name: String,
}

/// A complete trace (collection of spans for a single block processing run).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceComplete {
    pub trace_id: String,
    pub spans: Vec<SpanEvent>,
    pub root_span_name: String,
    pub duration_ms: f64,
    pub started_at: u64,
}

/// Events broadcast to WebSocket clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    /// Initial topology snapshot sent when a client connects.
    TopologySnapshot {
        nodes: Vec<Node>,
        edges: Vec<Edge>,
    },
    /// A full trace completed.
    TraceCompleted {
        trace: TraceComplete,
    },
    /// Topology changed (new node or edge discovered).
    TopologyUpdated {
        nodes: Vec<Node>,
        edges: Vec<Edge>,
    },
    /// Stats heartbeat
    Stats {
        total_traces: u64,
        spans_per_second: f64,
        active_nodes: usize,
        timestamp: u64,
    },
    /// A batch of span-arrived events — one broadcast per OTLP export call instead
    /// of one per span, which significantly reduces CPU usage at high span rates.
    SpansBatch {
        spans: Vec<SpanArrivedPayload>,
    },
}

/// In-flight spans keyed by trace_id, then by span_id.
pub type InFlightTraces = DashMap<String, HashMap<String, SpanEvent>>;

pub struct AppState {
    /// Pre-serialized JSON strings are broadcast so each connected WS client
    /// can forward the same bytes without re-serializing.
    pub broadcast: broadcast::Sender<Arc<String>>,
    pub nodes: DashMap<String, Node>,
    pub edges: DashMap<String, Edge>,
    pub in_flight: InFlightTraces,
    pub total_traces: std::sync::atomic::AtomicU64,
    pub total_spans: std::sync::atomic::AtomicU64,
    /// Span IDs → their span name (for parent-edge discovery)
    pub span_name_index: DashMap<String, String>,
    /// Span IDs → their start time (nanos) for edge latency computation
    pub span_start_index: DashMap<String, u64>,
    /// Last time (ms) topology was broadcast, for ≥500 ms throttle
    last_topo_ms: std::sync::atomic::AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        let (tx, _): (broadcast::Sender<Arc<String>>, _) = broadcast::channel(4096);
        Self {
            broadcast: tx,
            nodes: DashMap::new(),
            edges: DashMap::new(),
            in_flight: DashMap::new(),
            total_traces: std::sync::atomic::AtomicU64::new(0),
            total_spans: std::sync::atomic::AtomicU64::new(0),
            span_name_index: DashMap::new(),
            span_start_index: DashMap::new(),
            last_topo_ms: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Returns a JSON blob with the backend configuration sent to every new
    /// WebSocket client (and also available via GET /config).
    pub fn get_config_json(&self) -> Arc<String> {
        Arc::new(serde_json::json!({}).to_string())
    }

    pub fn get_topology_snapshot(&self) -> Arc<String> {
        let nodes: Vec<Node> = self.nodes.iter().map(|e| e.value().clone()).collect();
        let edges: Vec<Edge> = self.edges.iter().map(|e| e.value().clone()).collect();
        let msg = WsMessage::TopologySnapshot { nodes, edges };
        Arc::new(serde_json::to_string(&msg).unwrap_or_default())
    }

    pub fn ingest_span(
        &self,
        span: SpanEvent,
    ) -> SpanArrivedPayload {
        self.total_spans.fetch_add(1, Ordering::Relaxed);

        // Node ID = "target::name" (unique) ; category = target (color key)
        let node_id = format!("{}::{}", span.target, span.name);
        let category = span.target.clone();
        self.nodes
            .entry(node_id.clone())
            .and_modify(|n| n.span_count += 1)
            .or_insert_with(|| Node {
                id: node_id.clone(),
                label: short_label(&span.name),
                category: category.clone(),
                span_count: 1,
            });

        // Discover edge from parent span name → this span name
        let from_node = span.parent_span_id.as_ref().and_then(|pid| {
            self.span_name_index.get(pid).map(|t| t.clone())
        });

        // Call-delay: child.start_time − parent.start_time (ms)
        let edge_latency_ms: Option<f64> = span.parent_span_id.as_ref().and_then(|pid| {
            self.span_start_index.get(pid).map(|parent_ns| {
                span.start_time_unix_nano.saturating_sub(*parent_ns) as f64 / 1_000_000.0
            })
        });

        if let Some(ref from) = from_node {
            if from != &node_id {
                let edge_key = format!("{}=>{}", from, node_id);
                self.edges
                    .entry(edge_key)
                    .and_modify(|e| e.flow_count += 1)
                    .or_insert_with(|| Edge {
                        source: from.clone(),
                        target: node_id.clone(),
                        flow_count: 1,
                    });
            }
        }

        // Build the lightweight wire payload (no attributes)
        let payload = SpanArrivedPayload {
            trace_id: span.trace_id.clone(),
            span_id: span.span_id.clone(),
            parent_span_id: span.parent_span_id.clone(),
            name: span.name.clone(),
            target: span.target.clone(),
            start_time_unix_nano: span.start_time_unix_nano,
            end_time_unix_nano: span.end_time_unix_nano,
            duration_ms: span.duration_ms,
            status: span.status.clone(),
            service_name: span.service_name.clone(),
            from_node,
            to_node: node_id,
            edge_latency_ms,
        };

        // Accumulate full span (with attributes) into in-flight trace
        {
            let mut trace_spans = self
                .in_flight
                .entry(span.trace_id.clone())
                .or_insert_with(HashMap::new);
            trace_spans.insert(span.span_id.clone(), span);
        }

        payload
    }

    /// Broadcast a `topology_updated` message at most once per 500 ms.
    pub fn maybe_broadcast_topology(&self) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let last = self.last_topo_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) >= 500 {
            self.last_topo_ms.store(now_ms, Ordering::Relaxed);
            let nodes: Vec<Node> = self.nodes.iter().map(|e| e.value().clone()).collect();
            let edges: Vec<Edge> = self.edges.iter().map(|e| e.value().clone()).collect();
            let msg = WsMessage::TopologyUpdated { nodes, edges };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = self.broadcast.send(Arc::new(json));
            }
        }
    }

    pub fn finalize_trace(self: &Arc<Self>, trace_id: &str) {
        if let Some((_, spans_map)) = self.in_flight.remove(trace_id) {
            self.total_traces.fetch_add(1, Ordering::Relaxed);

            let mut spans: Vec<SpanEvent> = spans_map.into_values().collect();
            // Prune per-span lookup indexes for the completed trace
            for s in &spans {
                self.span_start_index.remove(&s.span_id);
                self.span_name_index.remove(&s.span_id);
            }
            spans.sort_by_key(|s| s.start_time_unix_nano);

            let started_at = spans.first().map(|s| s.start_time_unix_nano).unwrap_or(0);
            let ended_at = spans.iter().map(|s| s.end_time_unix_nano).max().unwrap_or(0);
            let duration_ms = (ended_at.saturating_sub(started_at)) as f64 / 1_000_000.0;
            let root_span_name = spans
                .iter()
                .find(|s| s.parent_span_id.is_none())
                .map(|s| s.name.clone())
                .unwrap_or_default();

            let trace = TraceComplete {
                trace_id: trace_id.to_string(),
                spans,
                root_span_name,
                duration_ms,
                started_at,
            };

            let _ = self.broadcast.send(Arc::new(
                serde_json::to_string(&WsMessage::TraceCompleted { trace }).unwrap_or_default()
            ));
        }
    }

    /// Evict in-flight traces older than `max_age` whose spans have never produced
    /// a root span (e.g. orphan partial traces dropped by the exporter).
    /// Called periodically from a background task so neither the index maps nor
    /// in_flight grow without bound under abnormal conditions.
    pub fn cleanup_stale_traces(self: &Arc<Self>, max_age: Duration) {
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;
        let cutoff_ns = now_ns.saturating_sub(max_age.as_nanos() as u64);

        let stale: Vec<String> = self
            .in_flight
            .iter()
            .filter(|entry| {
                // A trace is stale if every span in it started before the cutoff,
                // or if the entry is somehow empty.
                entry
                    .value()
                    .values()
                    .next()
                    .map(|s| s.start_time_unix_nano < cutoff_ns)
                    .unwrap_or(true)
            })
            .map(|entry| entry.key().clone())
            .collect();

        for trace_id in stale {
            tracing::debug!(trace_id = %trace_id, "evicting stale in-flight trace");
            self.finalize_trace(&trace_id);
        }
    }

    pub fn stats_snapshot(&self) -> Arc<String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let msg = WsMessage::Stats {
            total_traces: self.total_traces.load(Ordering::Relaxed),
            spans_per_second: 0.0,
            active_nodes: self.nodes.len(),
            timestamp: now,
        };
        Arc::new(serde_json::to_string(&msg).unwrap_or_default())
    }
}

fn short_label(name: &str) -> String {
    name
        .split("::")
        .last()
        .unwrap_or(name)
        .split('_')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
