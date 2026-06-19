//! Authoritative real-time game server. One process serves many tenants and worlds.
//!
//!   GET  /healthz         liveness probe
//!   GET  /ws              WebSocket game connection (first frame = Join)
//!   GET  /admin/stats     JSON of who is online, where, ping (needs x-admin-token)
//!   GET  /admin/bans      JSON list of banned IPs (needs x-admin-token)
//!   POST /admin/ban       ban an IP: { "ip": "1.2.3.4" } (needs x-admin-token)
//!   POST /admin/unban     unban an IP: { "ip": "1.2.3.4" } (needs x-admin-token)

mod bans;
mod conn;
mod hub;
mod persistence;
mod room;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

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
        .route("/admin/bans", get(admin_bans))
        .route("/admin/ban", post(admin_ban))
        .route("/admin/unban", post(admin_unban))
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

#[derive(Deserialize)]
struct BanReq {
    ip: String,
}

/// Returns a rejection response if the admin token is missing or wrong, else None.
/// The token is compared in constant time to avoid leaking it via timing.
fn check_admin(hub: &Hub, headers: &HeaderMap) -> Option<axum::response::Response> {
    let token = headers.get("x-admin-token").and_then(|v| v.to_str().ok());
    match token {
        Some(t) if constant_time_eq(t.as_bytes(), hub.admin_token.as_bytes()) => None,
        _ => Some((StatusCode::UNAUTHORIZED, "unauthorized").into_response()),
    }
}

/// Length-independent constant-time byte comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

async fn admin_stats(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(resp) = check_admin(&hub, &headers) {
        return resp;
    }
    Json(hub.admin_stats()).into_response()
}

async fn admin_bans(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(resp) = check_admin(&hub, &headers) {
        return resp;
    }
    Json(hub.bans.list()).into_response()
}

async fn admin_ban(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(req): Json<BanReq>,
) -> impl IntoResponse {
    if let Some(resp) = check_admin(&hub, &headers) {
        return resp;
    }
    let Ok(ip) = req.ip.parse::<IpAddr>() else {
        return (StatusCode::BAD_REQUEST, "invalid ip").into_response();
    };
    hub.bans.ban(ip);
    Json(hub.bans.list()).into_response()
}

async fn admin_unban(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(req): Json<BanReq>,
) -> impl IntoResponse {
    if let Some(resp) = check_admin(&hub, &headers) {
        return resp;
    }
    let Ok(ip) = req.ip.parse::<IpAddr>() else {
        return (StatusCode::BAD_REQUEST, "invalid ip").into_response();
    };
    hub.bans.unban(ip);
    Json(hub.bans.list()).into_response()
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn constant_time_eq_matches_only_equal_bytes() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret-longer"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }
}
