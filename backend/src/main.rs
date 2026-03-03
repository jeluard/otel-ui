mod db;
mod otlp;
mod state;
mod ws;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::Parser;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use db::Db;
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

    /// Path to the SQLite persistence database.
    /// Overrides the OTEL_UI_DB_PATH environment variable.
    #[arg(long, env = "OTEL_UI_DB_PATH", default_value = "./otel-ui.db")]
    db_path: PathBuf,

    /// Retain traces for this many days (0 = keep forever).
    /// Overrides the OTEL_UI_DB_RETENTION_DAYS environment variable.
    #[arg(long, env = "OTEL_UI_DB_RETENTION_DAYS", default_value_t = 7)]
    db_retention_days: u64,

    /// Prune traces older than --db-retention-days and exit immediately.
    #[arg(long, default_value_t = false)]
    prune: bool,
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

    // Open the SQLite database.
    let db = Arc::new(Db::open(&args.db_path)?);
    info!("Opened SQLite database at {:?}", args.db_path);

    // --prune mode: prune old traces and exit.
    if args.prune {
        if args.db_retention_days == 0 {
            info!("--db-retention-days is 0 (keep forever), nothing to prune");
        } else {
            let cutoff_ns = retention_cutoff_ns(args.db_retention_days);
            let pruned = db.prune(cutoff_ns)?;
            info!(
                "Pruned {} traces older than {} days",
                pruned, args.db_retention_days
            );
        }
        return Ok(());
    }

    let state = Arc::new(AppState::new(Arc::clone(&db)));

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

    // Background task: prune old DB rows once per day (if retention is set).
    if args.db_retention_days > 0 {
        let db_prune = Arc::clone(&db);
        let retention_days = args.db_retention_days;
        tokio::spawn(async move {
            // First prune on startup, then every 24 hours.
            loop {
                let cutoff_ns = retention_cutoff_ns(retention_days);
                match tokio::task::spawn_blocking({
                    let db = Arc::clone(&db_prune);
                    move || db.prune(cutoff_ns)
                })
                .await
                {
                    Ok(Ok(n)) if n > 0 => info!("Pruned {} old traces from DB", n),
                    Ok(Err(e)) => tracing::error!("DB prune error: {}", e),
                    _ => {}
                }
                tokio::time::sleep(std::time::Duration::from_secs(86_400)).await;
            }
        });
    }

    // Start the HTTP / WebSocket server
    info!("Starting HTTP/WebSocket server on {}", args.http_addr);
    ws::run_http_server(state, &args.http_addr).await?;

    Ok(())
}

/// Returns the nanosecond timestamp `retention_days` days in the past.
fn retention_cutoff_ns(retention_days: u64) -> i64 {
    let now_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i64;
    let window_ns = retention_days as i64 * 24 * 3_600 * 1_000_000_000;
    now_ns - window_ns
}
