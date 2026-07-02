//! The seam abstracting every hub-backed operation the SYNC room logic uses, so the room no longer
//! holds an `Arc<Hub>`. The native server backs it with `NativeRoomHost` (wrapping the hub); each
//! method maps 1:1 onto what the room used to do inline (alloc an id, hit the in-memory ban/claim
//! maps, publish the admin telemetry, or spawn a fire-and-forget admin-config db write).

use std::net::IpAddr;

use crate::conn::Conn;
use crate::role::Role;
use crate::stats::{RoomKey, RoomSnapshot};

/// Which per-tenant moderation flag a write-through targets.
pub enum TenantFlag {
    Suspended,
    ApprovalRequired,
}

/// Every hub-backed op the sync room logic calls. The native impl wraps `Arc<Hub>`; each method does
/// exactly what the room did inline before the split (the fire-and-forget admin-config writes reproduce
/// the same `tokio::spawn` + db call + `tracing::error!`).
pub trait RoomHost: Send + Sync {
    fn alloc_id(&self) -> u32;
    fn is_banned(&self, ip: IpAddr) -> bool;
    fn ban(&self, ip: IpAddr, name: String);
    fn unban(&self, ip: IpAddr) -> bool;
    fn list_named_bans(&self) -> Vec<(String, String)>;
    /// Whether `token` is still a live claim for `account_id` (the device that holds it is signed in).
    /// Many tokens can be live per account (one per device), so a stale token simply reports false.
    fn claim_is_live(&self, account_id: &str, token: &str) -> bool;
    fn publish_stats(&self, key: RoomKey, snapshot: RoomSnapshot);
    fn set_tenant_peace(&self, tenant: String, on: bool);
    fn set_tenant_pvp(&self, tenant: String, on: bool);
    fn set_tenant_chat(&self, tenant: String, on: bool);
    fn set_tenant_blocked_structures(&self, tenant: String, kinds: Vec<String>);
    fn set_role(&self, account_id: String, role: Role);
    fn set_tenant_suspended(&self, tenant: String, on: bool);
    fn set_tenant_approval_required(&self, tenant: String, on: bool);
    fn set_tenant_playtime(&self, tenant: String, limit_min: u32, window_h: u32);
    fn set_tenant_modes(&self, tenant: String, online_allowed: bool, offline_allowed: bool);
    fn refresh_pending_for_admins(&self, tenant: String, admin_conns: Vec<Conn>);
    fn approve_then_refresh(&self, tenant: String, account_id: String, admin_conns: Vec<Conn>);
    fn reject_then_refresh(&self, tenant: String, account_id: String, admin_conns: Vec<Conn>);
    fn clear_request_then_refresh(
        &self,
        tenant: String,
        account_id: String,
        admin_conns: Vec<Conn>,
    );
}

/// The plain config a room caches from the tenant row + the hub limits, so the sync logic reads `self.X`
/// instead of `self.hub.limits.X`. Built by the server in `get_or_create_room` and handed to `Room::new`.
pub struct RoomConfig {
    pub tenant: String,
    pub world: String,
    pub brand_name: String,
    pub brand_image: String,
    pub tick_hz: u32,
    pub max_players: usize,
    pub idle_secs: u64,
    pub edit_reach: f32,
    pub max_speed: f32,
    pub move_per_sec: f32,
    pub edit_per_sec: f32,
    pub chat_per_sec: f32,
}
