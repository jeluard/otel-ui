/// OTLP gRPC server — receives spans from the OpenTelemetry Collector
/// and feeds them into the shared AppState.

use std::sync::Arc;

use opentelemetry_proto::tonic::{
    collector::trace::v1::{
        trace_service_server::{TraceService, TraceServiceServer},
        ExportTraceServiceRequest, ExportTraceServiceResponse,
    },
    common::v1::{any_value::Value as AnyValueKind, AnyValue},
};
use tonic::{transport::Server, Request, Response, Status};
use tracing::info;

use crate::state::{AppState, SpanEvent, SpanArrivedPayload, WsMessage};

pub struct OtlpTraceReceiver {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl TraceService for OtlpTraceReceiver {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let req = request.into_inner();

        // ── Build the full batch first ────────────────────────────────────────
        // Children always close before their parents in Rust tracing (shorter
        // lifetimes finish first), so they arrive earlier in the OTLP batch.
        // If we ingest in order, the parent span hasn't been indexed yet when
        // the child look up its parent_span_id → edges are never discovered.
        //
        // Fix: collect the entire batch into a Vec, pre-index every span_id →
        // target in one pass, then ingest. Parent IDs are now always resolved.
        let mut batch: Vec<SpanEvent> = Vec::new();

        for resource_spans in req.resource_spans {
            let service_name = resource_spans
                .resource
                .as_ref()
                .and_then(|r| {
                    r.attributes.iter().find(|kv| kv.key == "service.name").and_then(|kv| {
                        kv.value.as_ref().and_then(|v| {
                            if let Some(AnyValueKind::StringValue(s)) = &v.value {
                                Some(s.clone())
                            } else {
                                None
                            }
                        })
                    })
                })
                .unwrap_or_else(|| "unknown".to_string());

            for scope_spans in resource_spans.scope_spans {
                let scope_target = scope_spans
                    .scope
                    .as_ref()
                    .map(|s| s.name.clone())
                    .unwrap_or_default();

                for span in scope_spans.spans {
                    let trace_id = hex::encode(&span.trace_id);
                    let span_id  = hex::encode(&span.span_id);
                    let parent_span_id = if span.parent_span_id.is_empty() {
                        None
                    } else {
                        Some(hex::encode(&span.parent_span_id))
                    };

                    let mut attributes: Vec<(String, String)> = Vec::new();
                    let mut span_target = scope_target.clone();

                    for kv in &span.attributes {
                        let val = kv_to_string(&kv.value);
                        if kv.key == "target" || kv.key == "code.namespace" {
                            span_target = val.clone();
                        }
                        attributes.push((kv.key.clone(), val));
                    }

                    if span_target.is_empty() {
                        span_target = span.name.clone();
                    }

                    let duration_ms = (span.end_time_unix_nano
                        .saturating_sub(span.start_time_unix_nano)) as f64
                        / 1_000_000.0;

                    let status = match span.status.as_ref().map(|s| s.code) {
                        Some(2) => "error",
                        Some(1) => "ok",
                        _ => "unset",
                    }
                    .to_string();

                    batch.push(SpanEvent {
                        trace_id,
                        span_id,
                        parent_span_id,
                        name: span.name.clone(),
                        target: span_target,
                        start_time_unix_nano: span.start_time_unix_nano,
                        end_time_unix_nano: span.end_time_unix_nano,
                        duration_ms,
                        attributes,
                        status,
                        service_name: service_name.clone(),
                    });
                }
            }
        }

        // ── Pass 1: pre-index every span_id in this batch ─────────────────────
        // Pre-indexing name AND start-time here avoids two DashMap writes per
        // span inside ingest_span (which runs in the hot loop).
        for s in &batch {
            // Index the composite node_id (target::name) so parent-edge discovery
            // in ingest_span resolves to the same qualified ID.
            self.state.span_name_index.insert(s.span_id.clone(), format!("{}::{}", s.target, s.name));
            self.state.span_start_index.insert(s.span_id.clone(), s.start_time_unix_nano);
        }

        // ── Pass 2+3: ingest spans and collect root trace IDs ─────────────────
        // Consuming the batch (`into_iter`) avoids cloning each SpanEvent,
        // which includes an expensive `HashMap<String, serde_json::Value>`.
        // Root trace IDs are noted here so we can finalise traces below
        // without a second pass over the batch.
        let mut payloads: Vec<SpanArrivedPayload> = Vec::with_capacity(batch.len());
        let mut root_trace_ids: Vec<String> = Vec::new();
        for s in batch {
            if s.parent_span_id.is_none() {
                root_trace_ids.push(s.trace_id.clone());
            }
            payloads.push(self.state.ingest_span(s));
        }

        // ── Single broadcast for the whole batch (one serialization, one wake-up per WS client) ─
        if !payloads.is_empty() {
            let msg = WsMessage::SpansBatch { spans: payloads };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = self.state.broadcast.send(Arc::new(json));
            }
        }

        // ── Topology update: at most once per 500 ms, once per batch ──────────
        // Moved out of ingest_span so SystemTime::now() is called once here
        // instead of N times (once per span) in the hot loop.
        self.state.maybe_broadcast_topology();

        // ── Finalise completed traces ──────────────────────────────────────────
        for trace_id in root_trace_ids {
            self.state.finalize_trace(&trace_id);
        }

        Ok(Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}

fn kv_to_string(value: &Option<AnyValue>) -> String {
    use AnyValueKind as Value;
    match value.as_ref().and_then(|v| v.value.as_ref()) {
        None                          => String::new(),
        Some(Value::StringValue(s))   => s.clone(),
        Some(Value::BoolValue(b))     => b.to_string(),
        Some(Value::IntValue(i))      => i.to_string(),
        Some(Value::DoubleValue(d))   => d.to_string(),
        Some(Value::BytesValue(b))    => hex::encode(b),
        Some(Value::ArrayValue(arr))  => {
            let parts: Vec<String> = arr.values.iter()
                .map(|v| kv_to_string(&Some(v.clone())))
                .collect();
            format!("[{}]", parts.join(", "))
        }
        Some(Value::KvlistValue(kv))  => {
            let parts: Vec<String> = kv.values.iter()
                .map(|kv| format!("{}={}", kv.key, kv_to_string(&kv.value)))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

pub async fn run_otlp_server(state: Arc<AppState>, addr: &str) -> anyhow::Result<()> {
    let addr = addr.parse()?;
    info!("OTLP gRPC server listening on {}", addr);

    let receiver = OtlpTraceReceiver { state };

    Server::builder()
        .add_service(TraceServiceServer::new(receiver))
        .serve(addr)
        .await?;

    Ok(())
}
