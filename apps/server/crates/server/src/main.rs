//! Authoritative real-time game server. One process serves many tenants and worlds.
//!
//!   GET  /healthz         liveness probe
//!   GET  /ws              WebSocket game connection (first frame = Join)
//!   GET  /admin/stats     JSON of who is online, where, ping (needs x-admin-token)
//!   GET  /admin/bans      JSON list of banned IPs (needs x-admin-token)
//!   POST /admin/ban       ban an IP: { "ip": "1.2.3.4" } (needs x-admin-token)
//!   POST /admin/unban     unban an IP: { "ip": "1.2.3.4" } (needs x-admin-token)
//!
//! Internal data API (Next -> Rust, HMAC-signed; see `internal_auth`):
//!   GET    /internal/tenants/:id          tenant JSON or 404
//!   GET    /internal/tenants              tenant list
//!   POST   /internal/tenants              upsert (body = Tenant JSON), returns it
//!   DELETE /internal/tenants/:id          delete tenant
//!   GET    /internal/leaderboard/:tenant  top scores JSON

mod bans;
mod conn;
mod db;
mod hub;
mod internal_auth;
mod persistence;
mod room;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use db::{Db, Tenant};
use hub::Hub;
use internal_auth::{AuthError, AuthHeaders, InternalAuth};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,server=debug".into()),
        )
        .init();

    let database = Arc::new(Db::open().await.expect("open database"));
    let hub = Arc::new(Hub::load(database).await);
    let auth = Arc::new(InternalAuth::from_env());
    let state = AppState {
        hub: hub.clone(),
        auth,
    };
    let bind = std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/admin/stats", get(admin_stats))
        .route("/admin/bans", get(admin_bans))
        .route("/admin/ban", post(admin_ban))
        .route("/admin/unban", post(admin_unban))
        .route("/ws", get(ws_handler))
        .route(
            "/internal/tenants",
            get(internal_list_tenants).post(internal_upsert_tenant),
        )
        .route(
            "/internal/tenants/{id}",
            get(internal_get_tenant).delete(internal_delete_tenant),
        )
        .route("/internal/leaderboard/{tenant}", get(internal_leaderboard))
        .with_state(state);

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

/// Shared router state. `FromRef` lets the existing WS/admin handlers keep extracting
/// `State<Arc<Hub>>` unchanged while the internal handlers extract the full `AppState`.
#[derive(Clone)]
struct AppState {
    hub: Arc<Hub>,
    auth: Arc<InternalAuth>,
}

impl axum::extract::FromRef<AppState> for Arc<Hub> {
    fn from_ref(state: &AppState) -> Self {
        state.hub.clone()
    }
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

/// Verify the HMAC signature on an internal request. The canonical path is taken from the
/// original URI (path + query) so it matches exactly what the Next proxy signed.
fn verify_internal(
    auth: &InternalAuth,
    method: &str,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Option<axum::response::Response> {
    let timestamp = header_str(headers, "x-bl-ts");
    let nonce = header_str(headers, "x-bl-nonce");
    let signature = header_str(headers, "x-bl-sig");
    let (Some(timestamp), Some(nonce), Some(signature)) = (timestamp, nonce, signature) else {
        return Some((StatusCode::UNAUTHORIZED, "unauthorized").into_response());
    };
    let path = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or(uri.path());
    auth.verify(
        method,
        path,
        body,
        &AuthHeaders {
            timestamp,
            nonce,
            signature,
        },
    )
    .err()
    .map(reject_auth)
}

fn header_str<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers.get(key).and_then(|v| v.to_str().ok())
}

fn reject_auth(error: AuthError) -> axum::response::Response {
    tracing::warn!(?error, "internal request rejected");
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

async fn internal_get_tenant(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "GET", &original_uri.0, &headers, b"") {
        return resp;
    }
    match state.hub.db.get_tenant(&id).await {
        Ok(Some(tenant)) => Json(tenant).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "not_found").into_response(),
        Err(e) => internal_error(e),
    }
}

async fn internal_list_tenants(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "GET", &original_uri.0, &headers, b"") {
        return resp;
    }
    match state.hub.db.list_tenants().await {
        Ok(tenants) => Json(tenants).into_response(),
        Err(e) => internal_error(e),
    }
}

async fn internal_upsert_tenant(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    let Ok(tenant) = serde_json::from_slice::<Tenant>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid_tenant").into_response();
    };
    match state.hub.db.upsert_tenant(&tenant).await {
        Ok(Some(saved)) => Json(saved).into_response(),
        Ok(None) => (StatusCode::INTERNAL_SERVER_ERROR, "upsert_failed").into_response(),
        Err(e) => internal_error(e),
    }
}

async fn internal_delete_tenant(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "DELETE", &original_uri.0, &headers, b"") {
        return resp;
    }
    match state.hub.db.delete_tenant(&id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => internal_error(e),
    }
}

async fn internal_leaderboard(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    Path(tenant): Path<String>,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "GET", &original_uri.0, &headers, b"") {
        return resp;
    }
    match state
        .hub
        .db
        .top_scores(&tenant, db::default_top_limit())
        .await
    {
        Ok(scores) => Json(scores).into_response(),
        Err(e) => internal_error(e),
    }
}

fn internal_error(error: libsql::Error) -> axum::response::Response {
    tracing::error!(error = %error, "internal db error");
    (StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response()
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
