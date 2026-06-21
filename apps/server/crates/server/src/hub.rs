//! Process-wide shared state: tenant config, resource limits, the room registry and
//! the live stats snapshot that powers the admin endpoint.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::bans::Bans;
use crate::db::{Db, Tenant};
use crate::room::{Room, RoomCmd};

pub type RoomKey = (String, String);

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
    pub primary: String,
    pub logo: Option<String>,
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

/// One row per online player in the admin view.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerInfo {
    pub id: u32,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub ping_ms: u32,
    pub idle_ms: u64,
    pub joined_at_ms: u64,
}

/// Per-room snapshot published every tick for the admin endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct RoomSnapshot {
    pub tenant: String,
    pub world: String,
    pub tick: u64,
    pub edits: usize,
    pub players: Vec<PlayerInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TenantInfo {
    pub id: String,
    pub name: String,
    pub primary: String,
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
    pub tenants: HashMap<String, TenantCfg>,
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

impl Hub {
    /// Build the hub from the authoritative database (the source of tenants) and the optional
    /// `TENANTS_FILE` (limits only). The db seeds the built-in tenants on first run, so the
    /// tenant list is always populated even on a fresh database.
    pub async fn load(db: Arc<Db>) -> Self {
        let admin_token =
            std::env::var("ADMIN_TOKEN").unwrap_or_else(|_| "dev-admin-secret".into());
        let limits = load_limits();

        let tenants = db.list_tenants().await.unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to load tenants from db");
            Vec::new()
        });
        let map = tenants
            .into_iter()
            .map(|t| (t.id.clone(), tenant_to_cfg(t)))
            .collect::<HashMap<_, _>>();
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

    /// Resolve the room actor for a tenant/world, spawning it on first use.
    /// Creation is atomic (DashMap entry) so concurrent joins can't spawn duplicate
    /// rooms for the same key.
    pub fn get_or_create_room(
        hub: &Arc<Hub>,
        tenant: &str,
        world: &str,
    ) -> Result<mpsc::Sender<RoomCmd>, String> {
        let Some(tcfg) = hub.tenants.get(tenant) else {
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
                let room = Room::new(hub.clone(), tcfg, world.to_string(), rx);
                tokio::spawn(room.run());
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
            .values()
            .map(|t| {
                let rooms = room_list.iter().filter(|r| r.tenant == t.id).count();
                let players = room_list
                    .iter()
                    .filter(|r| r.tenant == t.id)
                    .map(|r| r.players.len())
                    .sum();
                TenantInfo {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    primary: t.primary.clone(),
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

// The room/brand path only needs id, name, primary color and a logo. The avatar doubles as
// the white-label logo (matching the old `tenants.toml` mapping).
fn tenant_to_cfg(tenant: Tenant) -> TenantCfg {
    TenantCfg {
        id: tenant.id,
        name: tenant.name,
        primary: tenant.primary,
        logo: Some(tenant.avatar),
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
}
