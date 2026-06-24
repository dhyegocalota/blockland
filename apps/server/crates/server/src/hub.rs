//! Process-wide shared state: tenant config, resource limits, the room registry and
//! the live stats snapshot that powers the admin endpoint.

use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use game_core::{Room, RoomConfig};

use crate::bans::Bans;
use crate::db::{Db, Tenant};
use crate::persistence::DbPersistence;
use crate::room_driver::{self, NativeRoomHost};
use crate::room_io::RoomCmd;

pub use game_core::{RoomKey, RoomSnapshot};

/// In-memory mirror of the active claim per account: the single live session token that may act as
/// that account. Warmed from the db on startup, then the source of truth the room checks every
/// join/tick. An empty token is never a valid claim. Keyed by the stable `account_id`, never the name.
#[derive(Default)]
pub struct Claims {
    active: DashMap<String, String>,
}

impl Claims {
    pub fn set(&self, account_id: &str, token: &str) {
        self.active
            .insert(account_id.to_string(), token.to_string());
    }

    pub fn get(&self, account_id: &str) -> Option<String> {
        self.active.get(account_id).map(|t| t.value().clone())
    }

    /// Forget the claim only if `token` is the one currently held (a stale token must not evict a
    /// re-claimed session).
    pub fn remove(&self, account_id: &str, token: &str) {
        self.active
            .remove_if(account_id, |_, current| current.as_str() == token);
    }
}

#[derive(Debug, Clone)]
pub struct TenantCfg {
    pub id: String,
    pub name: String,
    pub image: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Limits {
    #[serde(default = "d_players")]
    pub max_players_per_room: usize,
    #[serde(default = "d_tick")]
    pub tick_hz: u32,
    #[serde(default = "d_ip")]
    pub max_conns_per_ip: u32,
    #[serde(default = "d_move")]
    pub move_per_sec: f32,
    #[serde(default = "d_edit")]
    pub edit_per_sec: f32,
    #[serde(default = "d_chat")]
    pub chat_per_sec: f32,
    #[serde(default = "d_idle")]
    pub idle_secs: u64,
    #[serde(default = "d_reach")]
    pub edit_reach: f32,
    #[serde(default = "d_speed")]
    pub max_speed: f32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_players_per_room: d_players(),
            tick_hz: d_tick(),
            max_conns_per_ip: d_ip(),
            move_per_sec: d_move(),
            edit_per_sec: d_edit(),
            chat_per_sec: d_chat(),
            idle_secs: d_idle(),
            edit_reach: d_reach(),
            max_speed: d_speed(),
        }
    }
}

fn d_players() -> usize {
    10
}
fn d_tick() -> u32 {
    30
}
fn d_ip() -> u32 {
    6
}
fn d_move() -> f32 {
    40.0
}
fn d_edit() -> f32 {
    25.0
}
fn d_chat() -> f32 {
    2.0
}
fn d_idle() -> u64 {
    45
}
fn d_reach() -> f32 {
    9.0
}
fn d_speed() -> f32 {
    18.0
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    #[serde(default)]
    limits: Limits,
}

#[derive(Debug, Clone, Serialize)]
pub struct TenantInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub rooms: usize,
    pub players: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdminStats {
    pub online: usize,
    pub rooms: usize,
    pub tenants: Vec<TenantInfo>,
    pub room_list: Vec<RoomSnapshot>,
}

pub struct Hub {
    pub tenants: DashMap<String, TenantCfg>,
    pub limits: Limits,
    pub rooms: DashMap<RoomKey, mpsc::Sender<RoomCmd>>,
    pub room_stats: DashMap<RoomKey, RoomSnapshot>,
    ip_conns: DashMap<IpAddr, u32>,
    next_id: AtomicU32,
    pub admin_token: String,
    pub bans: Arc<Bans>,
    pub db: Arc<Db>,
    pub claims: Claims,
}

// Timeline events and play-time windows are dropped after this window so usage logs are never kept
// indefinitely (Privacy Policy retention promise).
const ACTIVITY_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

impl Hub {
    /// Build the hub from the authoritative database (the source of tenants) and the optional
    /// `TENANTS_FILE` (limits only). The db seeds the built-in tenants on first run, so the
    /// tenant list is always populated even on a fresh database.
    pub async fn load(db: Arc<Db>) -> Self {
        let admin_token =
            std::env::var("ADMIN_TOKEN").unwrap_or_else(|_| "dev-admin-secret".into());
        let limits = apply_env_overrides(load_limits());

        let tenants = db.list_tenants().await.unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to load tenants from db");
            Vec::new()
        });
        let map = tenants
            .into_iter()
            .map(|t| (t.id.clone(), tenant_to_cfg(t)))
            .collect::<DashMap<_, _>>();
        tracing::info!(tenants = map.len(), "hub loaded");

        let claims = Claims::default();
        let warmed = db.all_claims().await.unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to load claims from db");
            Vec::new()
        });
        let claim_count = warmed.len();
        for (account_id, token) in warmed {
            claims.set(&account_id, &token);
        }
        tracing::info!(claims = claim_count, "claims warmed");

        // Behavioural/usage logs (timeline events incl. moderation reports, and play-time windows) are
        // never kept beyond the retention window. Mirrored in the public Privacy Policy.
        match db.purge_stale_events(ACTIVITY_RETENTION_MS).await {
            Ok(n) if n > 0 => tracing::info!(count = n, "purged stale events"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "failed to purge stale events"),
        }
        match db.purge_stale_playtime(ACTIVITY_RETENTION_MS).await {
            Ok(n) if n > 0 => tracing::info!(count = n, "purged stale playtime"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "failed to purge stale playtime"),
        }
        match db.purge_stale_chat(crate::db::CHAT_RETENTION_MS).await {
            Ok(n) if n > 0 => tracing::info!(count = n, "purged stale chat"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "failed to purge stale chat"),
        }

        Self {
            tenants: map,
            limits,
            rooms: DashMap::new(),
            room_stats: DashMap::new(),
            ip_conns: DashMap::new(),
            next_id: AtomicU32::new(1),
            admin_token,
            bans: Arc::new(Bans::load(db.clone()).await),
            db,
            claims,
        }
    }

    pub fn alloc_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn try_add_ip(&self, ip: IpAddr) -> bool {
        let mut entry = self.ip_conns.entry(ip).or_insert(0);
        if *entry >= self.limits.max_conns_per_ip {
            tracing::debug!(%ip, count = *entry, "ip connection rejected");
            return false;
        }
        *entry += 1;
        tracing::debug!(%ip, count = *entry, "ip connection accepted");
        true
    }

    pub fn remove_ip(&self, ip: IpAddr) {
        if let Some(mut entry) = self.ip_conns.get_mut(&ip) {
            *entry = entry.saturating_sub(1);
        }
    }

    pub fn remove_room(&self, key: &RoomKey) {
        self.rooms.remove(key);
        self.room_stats.remove(key);
    }

    /// Make a newly created/edited tenant resolvable immediately (no restart): mirror the db row into
    /// the live cache.
    pub fn upsert_tenant(&self, tenant: Tenant) {
        let id = tenant.id.clone();
        self.tenants.insert(id, tenant_to_cfg(tenant));
    }

    /// Make a deleted tenant stop serving immediately (no restart): drop it from the live cache so no
    /// new connection resolves it, notify its open room that it is going down and forget the room so
    /// live players are dropped.
    pub async fn delete_tenant(&self, id: &str) {
        self.tenants.remove(id);
        let key = (id.to_string(), "main".to_string());
        let Some(tx) = self.rooms.get(&key).map(|tx| tx.clone()) else {
            return;
        };
        let _ = tx
            .send(RoomCmd::Announce(protocol::ServerMsg::Event {
                kind: "server_down".into(),
                name: String::new(),
                detail: String::new(),
            }))
            .await;
        self.remove_room(&key);
    }

    /// Resolve the room actor for a tenant/world, spawning it on first use.
    /// Creation is atomic (DashMap entry) so concurrent joins can't spawn duplicate
    /// rooms for the same key.
    pub fn get_or_create_room(
        hub: &Arc<Hub>,
        tenant: &str,
        world: &str,
    ) -> Result<mpsc::Sender<RoomCmd>, String> {
        let Some(tcfg) = hub.tenants.get(tenant).map(|t| t.clone()) else {
            return Err("unknown_tenant".into());
        };
        // One persistent room per tenant (world is always "main").
        let key = (tenant.to_string(), world.to_string());
        if let Some(tx) = hub.rooms.get(&key) {
            return Ok(tx.clone());
        }
        match hub.rooms.entry(key.clone()) {
            dashmap::mapref::entry::Entry::Occupied(e) => Ok(e.get().clone()),
            dashmap::mapref::entry::Entry::Vacant(e) => {
                let (tx, rx) = mpsc::channel::<RoomCmd>(512);
                let config = RoomConfig {
                    tenant: tcfg.id.clone(),
                    world: world.to_string(),
                    brand_name: tcfg.name.clone(),
                    brand_image: tcfg.image.clone(),
                    tick_hz: hub.limits.tick_hz,
                    max_players: hub.limits.max_players_per_room,
                    idle_secs: hub.limits.idle_secs,
                    edit_reach: hub.limits.edit_reach,
                    max_speed: hub.limits.max_speed,
                    move_per_sec: hub.limits.move_per_sec,
                    edit_per_sec: hub.limits.edit_per_sec,
                    chat_per_sec: hub.limits.chat_per_sec,
                };
                let persistence = Arc::new(DbPersistence::new(hub.db.clone()));
                let host = Arc::new(NativeRoomHost { hub: hub.clone() });
                let room = Room::new(config, persistence, host);
                tokio::spawn(room_driver::run(room, hub.clone(), rx));
                e.insert(tx.clone());
                tracing::info!(%tenant, %world, "room spawned");
                Ok(tx)
            }
        }
    }

    /// Route a command to a tenant's live room, if one is currently running. Returns false when no
    /// room is open (nobody online) — the change is already persisted, so there is nothing to notify.
    pub async fn send_to_room(&self, tenant: &str, cmd: RoomCmd) -> bool {
        let key = (tenant.to_string(), "main".to_string());
        let Some(tx) = self.rooms.get(&key).map(|tx| tx.clone()) else {
            return false;
        };
        tx.send(cmd).await.is_ok()
    }

    /// Push a server-originated message to every live room (e.g. a shutdown notice). Senders are
    /// cloned out first so no DashMap shard lock is held across the awaits.
    pub async fn announce_all(&self, msg: protocol::ServerMsg) {
        let senders: Vec<_> = self.rooms.iter().map(|e| e.value().clone()).collect();
        for tx in senders {
            let _ = tx.send(RoomCmd::Announce(msg.clone())).await;
        }
    }

    /// Public lobby presence for a tenant: how many players are online and their names.
    pub fn online_for(&self, tenant: &str) -> (usize, Vec<String>) {
        let mut names = Vec::new();
        for entry in self.room_stats.iter() {
            let snap = entry.value();
            if snap.tenant == tenant {
                names.extend(snap.players.iter().map(|p| p.name.clone()));
            }
        }
        (names.len(), names)
    }

    pub fn admin_stats(&self) -> AdminStats {
        let mut room_list: Vec<RoomSnapshot> =
            self.room_stats.iter().map(|r| r.value().clone()).collect();
        room_list.sort_by(|a, b| {
            (a.tenant.as_str(), a.world.as_str()).cmp(&(b.tenant.as_str(), b.world.as_str()))
        });

        let online: usize = room_list.iter().map(|r| r.players.len()).sum();
        let tenants = self
            .tenants
            .iter()
            .map(|entry| {
                let t = entry.value();
                let rooms = room_list.iter().filter(|r| r.tenant == t.id).count();
                let players = room_list
                    .iter()
                    .filter(|r| r.tenant == t.id)
                    .map(|r| r.players.len())
                    .sum();
                TenantInfo {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    image: t.image.clone(),
                    rooms,
                    players,
                }
            })
            .collect();

        AdminStats {
            online,
            rooms: room_list.len(),
            tenants,
            room_list,
        }
    }
}

// Limits stay in `TENANTS_FILE` (branding now lives in the database). Defaults when absent.
fn load_limits() -> Limits {
    let Ok(path) = std::env::var("TENANTS_FILE") else {
        return Limits::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        tracing::warn!(%path, "tenants file not found, using default limits");
        return Limits::default();
    };
    match toml::from_str::<FileConfig>(&text) {
        Ok(cfg) => cfg.limits,
        Err(e) => {
            tracing::error!(%path, error = %e, "invalid tenants file, using default limits");
            Limits::default()
        }
    }
}

// Env overrides for the two capacity limits a load/stress test needs to raise without a config file:
// the per-room player cap (MAX_PLAYERS_PER_ROOM) and the per-IP connection cap (MAX_CONNECTIONS_PER_IP).
// Each falls back to the value already in `limits` (the file/default) when unset or unparseable, so the
// shipped defaults are unchanged; only an explicit, valid env value takes effect.
const MAX_PLAYERS_PER_ROOM_ENV: &str = "MAX_PLAYERS_PER_ROOM";
const MAX_CONNECTIONS_PER_IP_ENV: &str = "MAX_CONNECTIONS_PER_IP";

fn apply_env_overrides(mut limits: Limits) -> Limits {
    limits.max_players_per_room =
        env_override(MAX_PLAYERS_PER_ROOM_ENV, limits.max_players_per_room);
    limits.max_conns_per_ip = env_override(MAX_CONNECTIONS_PER_IP_ENV, limits.max_conns_per_ip);
    limits
}

fn env_override<T: std::str::FromStr>(name: &str, fallback: T) -> T {
    let Ok(raw) = std::env::var(name) else {
        return fallback;
    };
    match raw.parse::<T>() {
        Ok(value) => value,
        Err(_) => {
            tracing::warn!(env = name, value = %raw, "invalid limit override, using default");
            fallback
        }
    }
}

// The room/brand path only needs id, name and the one branding image.
fn tenant_to_cfg(tenant: Tenant) -> TenantCfg {
    TenantCfg {
        id: tenant.id,
        name: tenant.name,
        image: tenant.image,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_set_get_and_isolate_by_account() {
        let claims = Claims::default();
        claims.set("acc-a", "tokA");
        assert_eq!(claims.get("acc-a").as_deref(), Some("tokA"));
        assert!(claims.get("acc-b").is_none());
    }

    #[test]
    fn claims_set_replaces_previous_holder() {
        let claims = Claims::default();
        claims.set("acc-a", "tokA");
        claims.set("acc-a", "tokB");
        assert_eq!(claims.get("acc-a").as_deref(), Some("tokB"));
    }

    #[test]
    fn claims_remove_only_matches_current_token() {
        let claims = Claims::default();
        claims.set("acc-a", "tokB");
        claims.remove("acc-a", "tokA");
        assert_eq!(claims.get("acc-a").as_deref(), Some("tokB"));
        claims.remove("acc-a", "tokB");
        assert!(claims.get("acc-a").is_none());
    }

    #[test]
    fn env_override_parses_a_valid_value_and_falls_back_otherwise() {
        // Unique names so this never races another test touching the same process-global env.
        let set = "BL_TEST_OVERRIDE_SET";
        let garbage = "BL_TEST_OVERRIDE_GARBAGE";
        let unset = "BL_TEST_OVERRIDE_UNSET";

        std::env::set_var(set, "1000");
        assert_eq!(env_override::<usize>(set, 10), 1000);

        std::env::set_var(garbage, "not-a-number");
        assert_eq!(env_override::<u32>(garbage, 6), 6);

        std::env::remove_var(unset);
        assert_eq!(env_override::<u32>(unset, 6), 6);

        std::env::remove_var(set);
        std::env::remove_var(garbage);
    }

    fn tenant(id: &str) -> Tenant {
        Tenant {
            id: id.into(),
            name: id.into(),
            image: format!("/tenants/{id}/avatar.png"),
            playtime_limit_min: 0,
            playtime_window_h: 0,
            online_allowed: true,
            offline_allowed: true,
        }
    }

    #[tokio::test]
    async fn upsert_tenant_makes_it_resolvable_without_restart() {
        let hub = Hub::load(Arc::new(Db::memory().await)).await;
        assert!(hub.tenants.get("fresh").is_none());

        hub.upsert_tenant(tenant("fresh"));

        let cfg = hub
            .tenants
            .get("fresh")
            .expect("tenant resolves from live cache");
        assert_eq!(cfg.name, "fresh");
    }

    #[tokio::test]
    async fn delete_tenant_stops_it_resolving_and_drops_its_room() {
        let hub = Arc::new(Hub::load(Arc::new(Db::memory().await)).await);
        hub.upsert_tenant(tenant("doomed"));

        let key = ("doomed".to_string(), "main".to_string());
        let (tx, _rx) = mpsc::channel::<RoomCmd>(8);
        hub.rooms.insert(key.clone(), tx);

        hub.delete_tenant("doomed").await;

        assert!(hub.tenants.get("doomed").is_none());
        assert!(hub.rooms.get(&key).is_none());
    }
}
