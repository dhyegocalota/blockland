//! Authoritative real-time game server. One process serves many tenants and worlds.
//!
//!   GET  /healthz         liveness probe
//!   GET  /ws              WebSocket game connection (first frame = Join)
//!   GET  /admin/stats     JSON of who is online, where, ping (needs x-admin-token)
//!   GET  /admin/bans      JSON list of banned IPs (needs x-admin-token)
//!   POST /admin/ban       ban an IP: { "ip": "1.2.3.4" } (needs x-admin-token)
//!   POST /admin/unban     unban an IP: { "ip": "1.2.3.4" } (needs x-admin-token)
//!   GET  /admin/accounts/:tenant  list a tenant's accounts (needs x-admin-token)
//!   POST /admin/set-admin grant/revoke admin: { tenant, name|email, admin } -> account list (needs x-admin-token)
//!
//! Internal data API (Next -> Rust, HMAC-signed; see `internal_auth`):
//!   GET    /internal/tenants/:id          tenant JSON or 404
//!   GET    /internal/tenants              tenant list
//!   POST   /internal/tenants              upsert (body = Tenant JSON), returns it
//!   DELETE /internal/tenants/:id          delete tenant
//!   GET    /internal/leaderboard/:tenant  top scores JSON
//!   POST   /internal/uploads?key&content_type  upload a tenant asset, returns { "url" }
//!   POST   /internal/auth/request        start a login: { tenant, name, email } -> { ok, token, code, name, email }
//!   POST   /internal/auth/verify         finish a login: { token } or { tenant, name, code } -> { ok, tenant, name, claim, is_admin }
//!   POST   /internal/auth/logout         end a session: { tenant, claim } -> { ok }
//!   POST   /internal/auth/rename         rename a logged-in account: { tenant, claim, newName } -> { ok, name } | { ok:false, error }
//!   POST   /internal/waitlist            join the pre-launch waitlist: { email, name?, phone? } -> { ok }

mod approvals;
mod auth;
mod bans;
mod conn;
mod creatures;
mod db;
mod hub;
mod internal_auth;
mod notify;
mod persistence;
mod room;
mod storage;
mod suspensions;
mod uploads;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use db::{Db, Tenant};
use hub::Hub;
use internal_auth::{AuthError, AuthHeaders, InternalAuth};
use storage::Storage;
use uploads::MAX_UPLOAD_BYTES;

#[tokio::main]
async fn main() {
    // Error reporting: with SENTRY_DSN set, panics and every `tracing::error!` are sent to Sentry;
    // unset, sentry::init is a no-op. The guard must live for the whole process.
    let _sentry = sentry::init((
        std::env::var("SENTRY_DSN").ok(),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            send_default_pii: true,
            ..Default::default()
        },
    ));
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,server=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer())
        .init();

    let database = Arc::new(Db::open().await.expect("open database"));
    let hub = Arc::new(Hub::load(database).await);
    let auth = Arc::new(InternalAuth::from_env());
    let storage = storage::from_env();
    let state = AppState {
        hub: hub.clone(),
        auth,
        storage,
    };
    let bind = std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/online/{tenant}", get(public_online))
        .route("/admin/stats", get(admin_stats))
        .route("/admin/bans", get(admin_bans))
        .route("/admin/ban", post(admin_ban))
        .route("/admin/unban", post(admin_unban))
        .route("/admin/accounts/{tenant}", get(admin_accounts))
        .route("/admin/set-admin", post(admin_set_admin))
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
        .route("/internal/auth/request", post(internal_auth_request))
        .route("/internal/auth/verify", post(internal_auth_verify))
        .route("/internal/auth/logout", post(internal_auth_logout))
        .route("/internal/auth/rename", post(internal_auth_rename))
        .route("/internal/waitlist", post(internal_waitlist))
        .route(
            "/internal/uploads",
            post(uploads::internal_upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind");
    tracing::info!(%bind, "server listening");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(hub.clone()))
    .await
    .expect("serve");
}

/// Shared router state. `FromRef` lets the existing WS/admin handlers keep extracting
/// `State<Arc<Hub>>` unchanged while the internal handlers extract the full `AppState`.
#[derive(Clone)]
struct AppState {
    hub: Arc<Hub>,
    auth: Arc<InternalAuth>,
    storage: Arc<dyn Storage>,
}

impl axum::extract::FromRef<AppState> for Arc<Hub> {
    fn from_ref(state: &AppState) -> Self {
        state.hub.clone()
    }
}

async fn ws_handler(
    State(hub): State<Arc<Hub>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ip = client_ip(&headers, addr.ip());
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| conn::handle(socket, hub, ip))
}

/// The real client IP behind the reverse proxy (Cloudflare / Traefik), so per-player bans target the
/// player and not the shared proxy address. Cloudflare's header can't be spoofed through CF; the
/// first X-Forwarded-For hop is the next fallback; the direct peer is used in local dev (no proxy).
fn client_ip(headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    let from_header = |name: &str| -> Option<IpAddr> {
        headers
            .get(name)?
            .to_str()
            .ok()?
            .split(',')
            .next()?
            .trim()
            .parse()
            .ok()
    };
    from_header("cf-connecting-ip")
        .or_else(|| from_header("x-forwarded-for"))
        .unwrap_or(peer)
}

#[derive(serde::Serialize)]
struct OnlineResp {
    count: usize,
    names: Vec<String>,
    suspended: bool,
}

/// Public lobby presence for a tenant (no auth): who and how many are online right now.
async fn public_online(
    State(hub): State<Arc<Hub>>,
    Path(tenant): Path<String>,
) -> impl IntoResponse {
    let (count, names) = hub.online_for(&tenant);
    let suspended = hub.suspensions.is_suspended(&tenant);
    Json(OnlineResp {
        count,
        names,
        suspended,
    })
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

/// All accounts of a tenant for the /admin panel (grant/revoke admin). Needs `x-admin-token`.
async fn admin_accounts(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(tenant): Path<String>,
) -> impl IntoResponse {
    if let Some(resp) = check_admin(&hub, &headers) {
        return resp;
    }
    match hub.db.list_accounts(&tenant).await {
        Ok(accounts) => Json(accounts).into_response(),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
struct SetAdminReq {
    tenant: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    admin: bool,
}

/// Grant or revoke a tenant account's admin flag by name or email, returning the updated account
/// list. Needs `x-admin-token`. An identifier that matches no account is a 404 (the panel reports
/// it instead of a silent success).
async fn admin_set_admin(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(req): Json<SetAdminReq>,
) -> impl IntoResponse {
    if let Some(resp) = check_admin(&hub, &headers) {
        return resp;
    }
    let updated = match (&req.email, &req.name) {
        (Some(email), _) => {
            hub.db
                .set_admin_by_email(&req.tenant, email, req.admin)
                .await
        }
        (None, Some(name)) => hub.db.set_admin_by_name(&req.tenant, name, req.admin).await,
        (None, None) => return (StatusCode::BAD_REQUEST, "missing_identifier").into_response(),
    };
    match updated {
        Ok(true) => match hub.db.list_accounts(&req.tenant).await {
            Ok(accounts) => Json(accounts).into_response(),
            Err(e) => internal_error(e),
        },
        Ok(false) => (StatusCode::NOT_FOUND, "unknown_account").into_response(),
        Err(e) => internal_error(e),
    }
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
    let window = original_uri
        .0
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("window=")));
    let limit = db::default_top_limit();
    let result = if window == Some("month") {
        const MONTH_MS: i64 = 30 * 24 * 60 * 60 * 1000;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        state
            .hub
            .db
            .top_scores_since(&tenant, now - MONTH_MS, limit)
            .await
    } else {
        state.hub.db.top_scores(&tenant, limit).await
    };
    match result {
        Ok(scores) => Json(scores).into_response(),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
struct AuthRequestReq {
    tenant: String,
    #[serde(default)]
    name: String,
    email: String,
}

async fn internal_auth_request(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    let Ok(req) = serde_json::from_slice::<AuthRequestReq>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid_body").into_response();
    };
    // No name typed -> email-only login (look the account up by email); otherwise the name+email flow.
    let result = if req.name.trim().is_empty() {
        auth::request_by_email(&state.hub.db, &req.tenant, &req.email).await
    } else {
        auth::request(&state.hub.db, &req.tenant, &req.name, &req.email).await
    };
    match result {
        Ok(auth::RequestResult::Ok {
            token,
            code,
            name,
            email,
        }) => Json(serde_json::json!({
            "ok": true, "token": token, "code": code, "name": name, "email": email
        }))
        .into_response(),
        Ok(auth::RequestResult::NotOwner) => {
            Json(serde_json::json!({ "ok": false, "error": "not_owner" })).into_response()
        }
        Ok(auth::RequestResult::Invalid) => {
            Json(serde_json::json!({ "ok": false, "error": "invalid" })).into_response()
        }
        Ok(auth::RequestResult::Unknown) => {
            Json(serde_json::json!({ "ok": false, "error": "unknown_email" })).into_response()
        }
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
struct AuthVerifyReq {
    token: Option<String>,
    tenant: Option<String>,
    name: Option<String>,
    code: Option<String>,
}

async fn internal_auth_verify(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    let Ok(req) = serde_json::from_slice::<AuthVerifyReq>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid_body").into_response();
    };
    let by_code = match (&req.tenant, &req.name, &req.code) {
        (Some(tenant), Some(name), Some(code)) => {
            Some((tenant.as_str(), name.as_str(), code.as_str()))
        }
        _ => None,
    };
    let result = auth::verify(
        &state.hub.db,
        &state.hub.claims,
        req.token.as_deref(),
        by_code,
    )
    .await;
    match result {
        Ok(Some(verified)) => Json(serde_json::json!({
            "ok": true, "tenant": verified.tenant, "name": verified.name,
            "claim": verified.claim, "is_admin": verified.is_admin,
            "is_moderator": verified.is_moderator
        }))
        .into_response(),
        Ok(None) => Json(serde_json::json!({ "ok": false })).into_response(),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
struct AuthLogoutReq {
    tenant: String,
    claim: String,
}

async fn internal_auth_logout(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    let Ok(req) = serde_json::from_slice::<AuthLogoutReq>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid_body").into_response();
    };
    let result = auth::logout(&state.hub.db, &state.hub.claims, &req.tenant, &req.claim).await;
    match result {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
struct AuthRenameReq {
    tenant: String,
    claim: String,
    #[serde(rename = "newName")]
    new_name: String,
}

async fn internal_auth_rename(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    let Ok(req) = serde_json::from_slice::<AuthRenameReq>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid_body").into_response();
    };
    match auth::rename(&state.hub, &req.tenant, &req.claim, &req.new_name).await {
        Ok(auth::RenameResult::Ok { name }) => {
            Json(serde_json::json!({ "ok": true, "name": name })).into_response()
        }
        Ok(auth::RenameResult::NameTaken) => {
            Json(serde_json::json!({ "ok": false, "error": "name_taken" })).into_response()
        }
        Ok(auth::RenameResult::Invalid) => {
            Json(serde_json::json!({ "ok": false, "error": "invalid" })).into_response()
        }
        Err(e) => internal_error(e),
    }
}

#[derive(Deserialize)]
struct WaitlistReq {
    email: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    phone: Option<String>,
}

async fn internal_waitlist(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    let Ok(req) = serde_json::from_slice::<WaitlistReq>(&body) else {
        return (StatusCode::BAD_REQUEST, "invalid_body").into_response();
    };
    match state
        .hub
        .db
        .add_waitlist_entry(&req.email, req.name.as_deref(), req.phone.as_deref())
        .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => internal_error(e),
    }
}

fn internal_error(error: libsql::Error) -> axum::response::Response {
    tracing::error!(error = %error, "internal db error");
    (StatusCode::INTERNAL_SERVER_ERROR, "db_error").into_response()
}

/// How long to keep serving after the shutdown signal so the "server going down" feed notice reaches
/// connected clients before the process stops.
const SHUTDOWN_NOTICE_MS: u64 = 800;

/// Wait for a terminate signal — SIGTERM (how Docker/Swarm asks a container to stop) or Ctrl-C — then
/// tell every player, via the in-game feed, that the server is going down temporarily before we drop
/// their connections. Swarm's stop grace period covers the short notice delay.
async fn shutdown_signal(hub: Arc<Hub>) {
    wait_for_terminate().await;
    tracing::info!("shutdown signal received: notifying players");
    hub.announce_all(protocol::ServerMsg::Event {
        kind: "server_down".into(),
        name: String::new(),
        detail: String::new(),
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(SHUTDOWN_NOTICE_MS)).await;
    tracing::info!("shutting down");
}

async fn wait_for_terminate() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::{client_ip, constant_time_eq};
    use axum::http::HeaderMap;
    use std::net::IpAddr;

    #[test]
    fn constant_time_eq_matches_only_equal_bytes() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret-longer"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn client_ip_prefers_proxy_headers_over_the_peer() {
        let peer: IpAddr = "10.0.0.1".parse().unwrap();
        // No proxy headers (local dev): the direct peer is used.
        assert_eq!(client_ip(&HeaderMap::new(), peer), peer);
        // X-Forwarded-For: the first (original client) hop wins.
        let mut xff = HeaderMap::new();
        xff.insert("x-forwarded-for", "203.0.113.7, 70.1.2.3".parse().unwrap());
        assert_eq!(
            client_ip(&xff, peer),
            "203.0.113.7".parse::<IpAddr>().unwrap()
        );
        // Cloudflare's header takes priority over X-Forwarded-For.
        let mut cf = HeaderMap::new();
        cf.insert("cf-connecting-ip", "198.51.100.9".parse().unwrap());
        cf.insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        assert_eq!(
            client_ip(&cf, peer),
            "198.51.100.9".parse::<IpAddr>().unwrap()
        );
    }
}
