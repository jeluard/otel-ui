use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::db::Db;

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
    pub instance_id: String,
}

/// A complete trace (collection of spans for a single block processing run).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceComplete {
    pub trace_id: String,
    pub spans: Vec<SpanEvent>,
    pub root_span_name: String,
    pub duration_ms: f64,
    pub started_at: u64,
    /// Identifies which process instance produced this trace (from service.instance.id).
    pub instance_id: String,
}

/// A single metric data point decoded from OTLP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricEvent {
    pub service_name:        String,
    pub metric_name:         String,
    pub description:         String,
    pub unit:                String,
    pub timestamp_unix_nano: u64,
    pub attributes:          Vec<(String, String)>,
    pub value:               MetricValue,
}

/// The decoded value of a metric data point.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MetricValue {
    Gauge     { value: f64 },
    Sum       { value: f64, is_monotonic: bool },
    Histogram { count: u64, sum: f64, min: f64, max: f64 },
}

/// A single log record decoded from OTLP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEvent {
    pub timestamp_unix_nano: u64,
    pub observed_unix_nano:  u64,
    pub severity_text:       String,
    pub severity_number:     i32,
    pub body:                String,
    pub trace_id:            Option<String>,
    pub span_id:             Option<String>,
    pub attributes:          Vec<(String, String)>,
    pub service_name:        String,
}

/// Events broadcast to WebSocket clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    /// A batch of spans — one broadcast per OTLP export call.
    SpansBatch {
        spans: Vec<SpanEvent>,
    },
    /// A batch of metric data points — one broadcast per OTLP metrics export call.
    MetricsBatch {
        metrics: Vec<MetricEvent>,
    },
    /// A batch of log records — one broadcast per OTLP logs export call.
    LogsBatch {
        logs: Vec<LogEvent>,
    },
}

/// In-flight spans keyed by trace_id, then by span_id.
pub type InFlightTraces = DashMap<String, HashMap<String, SpanEvent>>;

pub struct AppState {
    /// Pre-serialized JSON strings are broadcast so each connected WS client
    /// can forward the same bytes without re-serializing.
    pub broadcast: broadcast::Sender<Arc<String>>,
    pub in_flight: InFlightTraces,
    pub total_traces: std::sync::atomic::AtomicU64,
    pub total_spans: std::sync::atomic::AtomicU64,
    /// Optional SQLite persistence layer.
    pub db: Arc<Db>,
}

impl AppState {
    pub fn new(db: Arc<Db>) -> Self {
        let (tx, _): (broadcast::Sender<Arc<String>>, _) = broadcast::channel(4096);
        Self {
            broadcast: tx,
            in_flight: DashMap::new(),
            total_traces: std::sync::atomic::AtomicU64::new(0),
            total_spans: std::sync::atomic::AtomicU64::new(0),
            db,
        }
    }

    /// Returns a JSON blob with the backend configuration sent to every new
    /// WebSocket client (and also available via GET /config).
    pub fn get_config_json(&self) -> Arc<String> {
        Arc::new(serde_json::json!({}).to_string())
    }

    pub fn finalize_trace(self: &Arc<Self>, trace_id: &str) {
        if let Some((_, spans_map)) = self.in_flight.remove(trace_id) {
            self.total_traces.fetch_add(1, Ordering::Relaxed);

            let mut spans: Vec<SpanEvent> = spans_map.into_values().collect();
            spans.sort_by_key(|s| s.start_time_unix_nano);

            let started_at = spans.first().map(|s| s.start_time_unix_nano).unwrap_or(0);
            let ended_at = spans.iter().map(|s| s.end_time_unix_nano).max().unwrap_or(0);
            let duration_ms = (ended_at.saturating_sub(started_at)) as f64 / 1_000_000.0;
            let root_span = spans.iter().find(|s| s.parent_span_id.is_none());
            let root_span_name = root_span.map(|s| s.name.clone()).unwrap_or_default();
            let instance_id = root_span.map(|s| s.instance_id.clone()).unwrap_or_default();

            let trace = TraceComplete {
                trace_id: trace_id.to_string(),
                spans,
                root_span_name,
                duration_ms,
                started_at,
                instance_id,
            };

            // Persist trace to SQLite asynchronously.
            let db = Arc::clone(&self.db);
            let service_name = trace.spans
                .iter()
                .find(|s| s.parent_span_id.is_none())
                .map(|s| s.service_name.clone())
                .unwrap_or_default();
            tokio::spawn(async move {
                if let Err(e) = tokio::task::spawn_blocking(move || {
                    db.insert_trace(&trace, &service_name, &trace.instance_id)
                }).await {
                    tracing::error!("Failed to persist trace: {}", e);
                }
            });
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

}


