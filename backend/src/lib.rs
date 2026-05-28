//! OTel bridge library: OTLP receivers (gRPC + HTTP) + WebSocket broadcaster.
//!
//! Embed this in any application to receive OpenTelemetry data and stream it
//! in real-time to browser clients over WebSockets.
//!
//! Default ports:
//!   4317 — OTLP gRPC  (traces, metrics, logs)
//!   4318 — OTLP HTTP  (traces, metrics, logs)
//!   8081 — WebSocket + HTTP API

pub mod db;
pub mod otlp;
pub mod state;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;

/// Spawn the full OTel bridge in a background thread with its own Tokio runtime.
///
/// - OTLP gRPC on `[::]:4317`
/// - OTLP HTTP on `0.0.0.0:4318`
/// - WebSocket + HTTP API on `0.0.0.0:8081`
///
/// The SQLite database for trace persistence is stored at `db_path`.
pub fn spawn(db_path: PathBuf) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build otel runtime");

        let db = Arc::new(db::Db::open(&db_path).expect("failed to open otel db"));
        let state = Arc::new(state::AppState::new(Arc::clone(&db)));

        rt.block_on(async {
            // OTLP gRPC receiver
            let s = state.clone();
            tokio::spawn(async move {
                if let Err(e) = otlp::run_otlp_server(s, "[::]:4317").await {
                    tracing::error!("OTLP gRPC error: {}", e);
                }
            });

            // OTLP HTTP receiver
            let s = state.clone();
            tokio::spawn(async move {
                if let Err(e) = otlp::run_otlp_http_server(s, "0.0.0.0:4318").await {
                    tracing::error!("OTLP HTTP error: {}", e);
                }
            });

            // Cleanup stale in-flight traces every 30 s
            let s = state.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
                loop {
                    tick.tick().await;
                    s.cleanup_stale_traces(std::time::Duration::from_secs(60));
                }
            });

            // WebSocket + HTTP API server (blocks until shutdown)
            if let Err(e) = ws::run_http_server(state, "0.0.0.0:8081").await {
                tracing::error!("WebSocket server error: {}", e);
            }
        });
    });
}
