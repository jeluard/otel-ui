mod otlp;
mod state;
mod ws;

use std::sync::Arc;
use clap::Parser;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use state::AppState;

/// OTel UI backend — receives spans via OTLP gRPC and serves a real-time
/// trace visualisation UI over WebSockets.
#[derive(Parser)]
#[command(name = "otel-ui-backend", about = "OTel live trace visualisation backend")]
struct Args {
    /// OTLP gRPC bind address
    #[arg(long, default_value = "[::]:4317")]
    otlp_addr: String,

    /// HTTP / WebSocket bind address
    #[arg(long, default_value = "0.0.0.0:8081")]
    http_addr: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "otel_ui_backend=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let args = Args::parse();

    let state = Arc::new(AppState::new());

    // Start the OTLP gRPC receiver
    let otlp_state = state.clone();
    let otlp_addr  = args.otlp_addr.clone();
    tokio::spawn(async move {
        if let Err(e) = otlp::run_otlp_server(otlp_state, &otlp_addr).await {
            tracing::error!("OTLP server error: {}", e);
        }
    });

    // Background task: evict stale in-flight traces
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            cleanup_state.cleanup_stale_traces(std::time::Duration::from_secs(60));
        }
    });

    // Start the HTTP / WebSocket server
    info!("Starting HTTP/WebSocket server on {}", args.http_addr);
    ws::run_http_server(state, &args.http_addr).await?;

    Ok(())
}
