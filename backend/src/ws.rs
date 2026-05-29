//! HTTP server with WebSocket endpoint for the UI.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{StatusCode, Uri},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, info, warn};

use crate::state::AppState;

type SharedState = Arc<AppState>;

pub async fn run_http_server(state: SharedState, bind: &str) -> anyhow::Result<()> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/config", get(config_handler))
        .route("/api/traces", get(traces_handler))
        .route("/api/traces/bounds", get(traces_bounds_handler))
        .route("/amaru-dashboard/", get(dashboard_proxy))
        .route("/amaru-dashboard/{*path}", get(dashboard_proxy))
        .layer(cors)
        .with_state(state);

    info!("UI available at  http://{}", bind);
    info!("WebSocket at     ws://{}/ws", bind);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async { tokio::signal::ctrl_c().await.ok(); })
        .await?;
    Ok(())
}

async fn health_handler() -> &'static str {
    "ok"
}

async fn config_handler(
    State(state): State<SharedState>,
) -> impl IntoResponse {
    use axum::http::{header, StatusCode};
    (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], (*state.get_config_json()).clone())
}

/// Reverse-proxy for the amaru-dashboard static assets.
///
/// Requests to `/amaru-dashboard/...` are forwarded to
/// `https://jeluard.github.io/amaru-dashboard/...` and returned verbatim.
/// Because the iframe is served from `http://localhost:8081`, the WebSocket
/// connection to `ws://localhost:8081/ws` is same-origin and never subject
/// to mixed-content blocking.
async fn dashboard_proxy(uri: Uri) -> impl IntoResponse {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    });

    let suffix = uri.path().strip_prefix("/amaru-dashboard").unwrap_or("");
    let url = format!("https://jeluard.github.io/amaru-dashboard{}", suffix);

    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let body = resp.bytes().await.unwrap_or_default();
            axum::response::Response::builder()
                .status(status)
                .header(axum::http::header::CONTENT_TYPE, &content_type)
                .body(axum::body::Body::from(body))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(e) => {
            warn!("Dashboard proxy error for {}: {}", uri.path(), e);
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

// ── History API ──────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TraceQueryParams {
    from: i64,
    to: i64,
    limit: Option<usize>,
    service: Option<String>,
    min_duration_ms: Option<f64>,
    max_duration_ms: Option<f64>,
}

async fn traces_handler(
    State(state): State<SharedState>,
    Query(params): Query<TraceQueryParams>,
) -> impl IntoResponse {
    let db = Arc::clone(&state.db);
    let limit = params.limit.unwrap_or(2000);
    let service = params.service.clone();
    let min_dur = params.min_duration_ms;
    let max_dur = params.max_duration_ms;
    match tokio::task::spawn_blocking(move || {
        db.query_traces(
            params.from,
            params.to,
            limit,
            service.as_deref(),
            min_dur,
            max_dur,
        )
    })
    .await
    {
        Ok(Ok(traces)) => Json(traces).into_response(),
        Ok(Err(e)) => {
            tracing::error!("DB query error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn traces_bounds_handler(
    State(state): State<SharedState>,
) -> impl IntoResponse {
    let db = Arc::clone(&state.db);
    match tokio::task::spawn_blocking(move || db.get_bounds()).await {
        Ok(Ok(bounds)) => Json(bounds).into_response(),
        Ok(Err(e)) => {
            tracing::error!("DB bounds error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to broadcast channel
    let mut rx = state.broadcast.subscribe();

    loop {
        tokio::select! {
            // Forward broadcast events to WS client
            msg = rx.recv() => {
                match msg {
                    Ok(event) => {
                        if sender.send(Message::Text((*event).clone().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        debug!("WebSocket client lagged by {} messages", n);
                    }
                    Err(_) => break,
                }
            }

            // Handle incoming messages from client (ping/pong)
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    info!("WebSocket client disconnected");
}
