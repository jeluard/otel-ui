//! OTLP gRPC + HTTP server — receives spans and metrics from the OpenTelemetry
//! Collector and feeds them into the shared AppState.

use std::sync::Arc;

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use opentelemetry_proto::tonic::{
    collector::metrics::v1::{
        metrics_service_server::{MetricsService, MetricsServiceServer},
        ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    },
    collector::trace::v1::{
        trace_service_server::{TraceService, TraceServiceServer},
        ExportTraceServiceRequest, ExportTraceServiceResponse,
    },
    common::v1::{any_value::Value as AnyValueKind, AnyValue},
    metrics::v1::{metric::Data, number_data_point::Value as NumberValue},
};
use prost::Message;
use tonic::{transport::Server, Request, Response, Status};
use tracing::info;

use crate::state::{AppState, MetricEvent, MetricValue, SpanEvent, WsMessage};

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

            let instance_id = resource_spans
                .resource
                .as_ref()
                .and_then(|r| {
                    r.attributes.iter().find(|kv| kv.key == "service.instance.id").and_then(|kv| {
                        kv.value.as_ref().and_then(|v| {
                            if let Some(AnyValueKind::StringValue(s)) = &v.value {
                                Some(s.clone())
                            } else {
                                None
                            }
                        })
                    })
                })
                .unwrap_or_default();

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
                        instance_id: instance_id.clone(),
                    });
                }
            }
        }

        // ── Collect root trace IDs, broadcast, store in in_flight ─────────────
        let mut root_trace_ids: Vec<String> = Vec::new();
        for s in &batch {
            self.state.total_spans.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if s.parent_span_id.is_none() {
                root_trace_ids.push(s.trace_id.clone());
            }
        }

        // Broadcast full spans (clone needed; original moves into in_flight below)
        if !batch.is_empty() {
            let msg = WsMessage::SpansBatch { spans: batch.clone() };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = self.state.broadcast.send(Arc::new(json));
            }
        }

        // Store in in_flight for SQLite persistence on trace completion
        for s in batch {
            self.state.in_flight
                .entry(s.trace_id.clone())
                .or_default()
                .insert(s.span_id.clone(), s);
        }

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

// ── Metrics receiver ────────────────────────────────────────────────────────

pub struct OtlpMetricsReceiver {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl MetricsService for OtlpMetricsReceiver {
    async fn export(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        let req = request.into_inner();
        let mut batch: Vec<MetricEvent> = Vec::new();

        for resource_metrics in req.resource_metrics {
            let service_name = resource_metrics
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

            for scope_metrics in resource_metrics.scope_metrics {
                for metric in scope_metrics.metrics {
                    let name        = metric.name.clone();
                    let description = metric.description.clone();
                    let unit        = metric.unit.clone();

                    match metric.data {
                        Some(Data::Gauge(g)) => {
                            for dp in g.data_points {
                                let v = match dp.value {
                                    Some(NumberValue::AsDouble(d)) => d,
                                    Some(NumberValue::AsInt(i))    => i as f64,
                                    None                           => continue,
                                };
                                batch.push(MetricEvent {
                                    service_name:        service_name.clone(),
                                    metric_name:         name.clone(),
                                    description:         description.clone(),
                                    unit:                unit.clone(),
                                    timestamp_unix_nano: dp.time_unix_nano,
                                    attributes:          dp.attributes.iter().map(|kv| (kv.key.clone(), kv_to_string(&kv.value))).collect(),
                                    value:               MetricValue::Gauge { value: v },
                                });
                            }
                        }
                        Some(Data::Sum(s)) => {
                            let is_monotonic = s.is_monotonic;
                            for dp in s.data_points {
                                let v = match dp.value {
                                    Some(NumberValue::AsDouble(d)) => d,
                                    Some(NumberValue::AsInt(i))    => i as f64,
                                    None                           => continue,
                                };
                                batch.push(MetricEvent {
                                    service_name:        service_name.clone(),
                                    metric_name:         name.clone(),
                                    description:         description.clone(),
                                    unit:                unit.clone(),
                                    timestamp_unix_nano: dp.time_unix_nano,
                                    attributes:          dp.attributes.iter().map(|kv| (kv.key.clone(), kv_to_string(&kv.value))).collect(),
                                    value:               MetricValue::Sum { value: v, is_monotonic },
                                });
                            }
                        }
                        Some(Data::Histogram(h)) => {
                            for dp in h.data_points {
                                batch.push(MetricEvent {
                                    service_name:        service_name.clone(),
                                    metric_name:         name.clone(),
                                    description:         description.clone(),
                                    unit:                unit.clone(),
                                    timestamp_unix_nano: dp.time_unix_nano,
                                    attributes:          dp.attributes.iter().map(|kv| (kv.key.clone(), kv_to_string(&kv.value))).collect(),
                                    value:               MetricValue::Histogram {
                                        count: dp.count,
                                        sum:   dp.sum.unwrap_or(0.0),
                                        min:   dp.min.unwrap_or(f64::NAN),
                                        max:   dp.max.unwrap_or(f64::NAN),
                                    },
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        if !batch.is_empty() {
            let msg = WsMessage::MetricsBatch { metrics: batch };
            if let Ok(json) = serde_json::to_string(&msg) {
                let _ = self.state.broadcast.send(Arc::new(json));
            }
        }

        Ok(Response::new(ExportMetricsServiceResponse { partial_success: None }))
    }
}

pub async fn run_otlp_server(state: Arc<AppState>, addr: &str) -> anyhow::Result<()> {
    let addr = addr.parse()?;
    info!("OTLP gRPC receiver on {}", addr);

    Server::builder()
        .add_service(TraceServiceServer::new(OtlpTraceReceiver { state: state.clone() }))
        .add_service(MetricsServiceServer::new(OtlpMetricsReceiver { state }))
        .serve(addr)
        .await?;

    Ok(())
}

// ── OTLP/HTTP (port 4318) ────────────────────────────────────────────────────

/// Process a raw protobuf body as an ExportTraceServiceRequest.
async fn http_traces(
    State(state): State<Arc<AppState>>,
    _headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let req = match ExportTraceServiceRequest::decode(body) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("OTLP/HTTP trace decode error: {}", e);
            return StatusCode::BAD_REQUEST;
        }
    };
    // Reuse the same processing logic as the gRPC handler.
    let receiver = OtlpTraceReceiver { state };
    let _ = receiver.export(Request::new(req)).await;
    StatusCode::OK
}

/// Process a raw protobuf body as an ExportMetricsServiceRequest.
async fn http_metrics(
    State(state): State<Arc<AppState>>,
    _headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let req = match ExportMetricsServiceRequest::decode(body) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("OTLP/HTTP metrics decode error: {}", e);
            return StatusCode::BAD_REQUEST;
        }
    };
    let receiver = OtlpMetricsReceiver { state };
    let _ = receiver.export(Request::new(req)).await;
    StatusCode::OK
}

pub async fn run_otlp_http_server(state: Arc<AppState>, addr: &str) -> anyhow::Result<()> {
    let addr: std::net::SocketAddr = addr.parse()?;
    info!("OTLP HTTP receiver on {} (protobuf, /v1/traces + /v1/metrics)", addr);

    let app = Router::new()
        .route("/v1/traces",  post(http_traces))
        .route("/v1/metrics", post(http_metrics))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
