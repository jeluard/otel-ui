/// HTTP server with WebSocket endpoint for the UI.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::time::interval;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, info};

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
        .layer(cors)
        .with_state(state);

    info!("HTTP server listening on {}", bind);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
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

    // Send initial topology snapshot
    let snapshot = state.get_topology_snapshot();
    let _ = sender.send(Message::Text((*snapshot).clone().into())).await;

    // Stats heartbeat every 2s
    let state_clone = state.clone();
    let mut stats_interval = interval(Duration::from_secs(2));

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

            // Stats heartbeat
            _ = stats_interval.tick() => {
                let stats = state_clone.stats_snapshot();
                if sender.send(Message::Text((*stats).clone().into())).await.is_err() {
                    break;
                }
            }

            // Handle incoming messages from client (ping/pong or topology request)
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if text.trim() == "topology" {
                            let snap = state.get_topology_snapshot();
                            let _ = sender.send(Message::Text((*snap).clone().into())).await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    info!("WebSocket client disconnected");
}
