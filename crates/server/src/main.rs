//! Authoritative real-time game server. One process serves many tenants and worlds.
//!
//!   GET /healthz          liveness probe
//!   GET /ws               WebSocket game connection (first frame = Join)
//!   GET /admin/stats      JSON of who is online, where, ping (needs x-admin-token)

mod conn;
mod hub;
mod room;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};

use hub::Hub;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,server=debug".into()),
        )
        .init();

    let hub = Arc::new(Hub::load());
    let bind = std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/admin/stats", get(admin_stats))
        .route("/ws", get(ws_handler))
        .with_state(hub.clone());

    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind");
    tracing::info!(%bind, "server listening");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("serve");
}

async fn ws_handler(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| conn::handle(socket, hub, addr.ip()))
}

async fn admin_stats(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> impl IntoResponse {
    let Some(token) = headers.get("x-admin-token").and_then(|v| v.to_str().ok()) else {
        return (StatusCode::UNAUTHORIZED, "missing x-admin-token").into_response();
    };
    if token != hub.admin_token {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    Json(hub.admin_stats()).into_response()
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
