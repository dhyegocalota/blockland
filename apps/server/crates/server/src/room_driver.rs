//! The async I/O shell around a `game_core::Room`: the tick-driver run loop, the db-backed admit policy
//! (every db read + gate, in the same order/outcomes as before), and `NativeRoomHost` — the native
//! backing for the room's hub-backed seam. The pure game logic lives in `game_core`; this owns the
//! tokio/db/hub side that drives it.

use std::net::IpAddr;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use std::time::{Duration, Instant};

use game_core::{
    playtime_key, Admission, Appearance, BacklogEvent, Conn, Outbound, Role, Room, RoomHost,
    RoomKey, RoomSnapshot,
};
use protocol::PlayerId;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::db::Db;
use crate::hub::Hub;
use crate::room_io::RoomCmd;

/// The native backing for the room's hub-backed seam: every method does exactly what the room did inline
/// before the split — alloc an id, hit the in-memory ban/claim maps, publish the admin telemetry, or
/// spawn the same fire-and-forget admin-config db write (same `tokio::spawn` body + `tracing::error!`).
pub struct NativeRoomHost {
    pub hub: Arc<Hub>,
}

impl RoomHost for NativeRoomHost {
    fn alloc_id(&self) -> u32 {
        self.hub.alloc_id()
    }

    fn is_banned(&self, ip: IpAddr) -> bool {
        self.hub.bans.is_banned(ip)
    }

    fn ban(&self, ip: IpAddr, name: String) {
        self.hub.bans.ban(ip, name);
    }

    fn unban(&self, ip: IpAddr) -> bool {
        self.hub.bans.unban(ip)
    }

    fn list_named_bans(&self) -> Vec<(String, String)> {
        self.hub.bans.list_named()
    }

    fn claim_is_live(&self, account_id: &str, token: &str) -> bool {
        self.hub.claims.is_live(account_id, token)
    }

    fn publish_stats(&self, key: RoomKey, snapshot: RoomSnapshot) {
        self.hub.room_stats.insert(key, snapshot);
    }

    fn set_tenant_peace(&self, tenant: String, on: bool) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_peace(&tenant, on).await {
                tracing::error!(error = %e, "set_tenant_peace failed");
            }
        });
    }

    fn set_tenant_pvp(&self, tenant: String, on: bool) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_pvp(&tenant, on).await {
                tracing::error!(error = %e, "set_tenant_pvp failed");
            }
        });
    }

    fn set_tenant_chat(&self, tenant: String, on: bool) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_chat(&tenant, on).await {
                tracing::error!(error = %e, "set_tenant_chat failed");
            }
        });
    }

    fn set_tenant_blocked_structures(&self, tenant: String, kinds: Vec<String>) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_blocked_structures(&tenant, &kinds).await {
                tracing::error!(error = %e, "set_tenant_blocked_structures failed");
            }
        });
    }

    fn set_role(&self, account_id: String, role: Role) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_role(&account_id, role).await {
                tracing::error!(error = %e, "set_role persist failed");
            }
        });
    }

    fn set_tenant_suspended(&self, tenant: String, on: bool) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_suspended(&tenant, on).await {
                tracing::error!(error = %e, "failed to persist tenant flag");
            }
        });
    }

    fn set_tenant_approval_required(&self, tenant: String, on: bool) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_approval_required(&tenant, on).await {
                tracing::error!(error = %e, "failed to persist tenant flag");
            }
        });
    }

    fn set_tenant_playtime(&self, tenant: String, limit_min: u32, window_h: u32) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_playtime(&tenant, limit_min, window_h).await {
                tracing::error!(error = %e, "set_tenant_playtime failed");
            }
        });
    }

    fn set_tenant_modes(&self, tenant: String, online_allowed: bool, offline_allowed: bool) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db
                .set_tenant_modes(&tenant, online_allowed, offline_allowed)
                .await
            {
                tracing::error!(error = %e, "set_tenant_modes failed");
            }
        });
    }

    fn refresh_pending_for_admins(&self, tenant: String, admin_conns: Vec<Conn>) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            send_pending(&db, &tenant, &admin_conns).await;
        });
    }

    fn approve_then_refresh(&self, tenant: String, account_id: String, admin_conns: Vec<Conn>) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.approve_account(&tenant, &account_id).await {
                tracing::error!(error = %e, "approve_account persist failed");
                return;
            }
            tracing::info!(%tenant, %account_id, "account approved by admin");
            send_pending(&db, &tenant, &admin_conns).await;
        });
    }

    fn reject_then_refresh(&self, tenant: String, account_id: String, admin_conns: Vec<Conn>) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.reject_approval_request(&tenant, &account_id).await {
                tracing::error!(error = %e, "reject persist failed");
                return;
            }
            tracing::info!(%tenant, %account_id, "account rejected by admin");
            send_pending(&db, &tenant, &admin_conns).await;
        });
    }

    fn clear_request_then_refresh(
        &self,
        tenant: String,
        account_id: String,
        admin_conns: Vec<Conn>,
    ) {
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.clear_approval_request(&tenant, &account_id).await {
                tracing::error!(error = %e, "ban pending: clearing request failed");
                return;
            }
            // The key carries the guest's `ip:<addr>`; recover it for the same log the inline spawn emitted.
            if let Some(ip) = account_id.strip_prefix("ip:") {
                tracing::info!(%tenant, %ip, "pending player banned by admin");
            }
            send_pending(&db, &tenant, &admin_conns).await;
        });
    }
}

// A room lease is considered stale (free to be retaken by another instance) once its last heartbeat
// is this old; the owning instance renews well within the window so a live room is never stolen.
pub const LEASE_STALE_MS: i64 = 30_000;
const LEASE_RENEW_MS: u64 = 5_000;

pub async fn run(mut room: Room, hub: Arc<Hub>, mut rx: mpsc::Receiver<RoomCmd>) {
    restore_world(&mut room, &hub).await;
    let dt = 1.0 / room.tick_hz() as f32;
    let mut interval = tokio::time::interval(Duration::from_secs_f64(1.0 / room.tick_hz() as f64));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Keep our cross-instance lease warm while the room is open, so no other instance treats it as
    // stale and takes over. The lease is only ever HELD here once a join cleared it in
    // `resolve_admission`; renew is a no-op (UPDATE ... WHERE owner) when the row isn't ours.
    let mut renew = tokio::time::interval(Duration::from_millis(LEASE_RENEW_MS));
    renew.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                // The I/O shell reads the clock ONCE per tick and feeds it to the game logic, which
                // never calls `Instant::now()` itself — the seam a WASM core needs.
                if !room.tick_at(Instant::now(), dt) {
                    break;
                }
            }
            _ = renew.tick() => {
                let (tenant, world) = room.key().clone();
                if let Err(e) = hub
                    .db
                    .renew_room_lease(&tenant, &world, &hub.owner, epoch_ms() as i64)
                    .await
                {
                    tracing::error!(%tenant, %world, error = %e, "room lease renew failed");
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    // Likewise one clock read per event, passed into the handler.
                    Some(c) => handle(&mut room, &hub, Instant::now(), c).await,
                    None => break,
                }
            }
        }
    }
    // Final save (awaited) so nothing is lost when the room closes.
    if room.is_dirty() {
        let blob = room.world_snapshot_blob();
        if let Err(e) = hub.db.save_world(&room.key().0, &blob).await {
            tracing::error!(tenant = %room.key().0, error = %e, "final world save failed");
        }
    }
    // Release our lease so another instance can serve this room immediately (DELETE ... WHERE owner,
    // so a row another instance already took over is never removed).
    let (tenant, world) = room.key().clone();
    if let Err(e) = hub.db.release_room_lease(&tenant, &world, &hub.owner).await {
        tracing::error!(%tenant, %world, error = %e, "room lease release failed");
    }
    hub.remove_room(room.key());
    tracing::info!(tenant = %room.key().0, world = %room.key().1, "room closed");
}

/// Load the tenant's saved world from the db and apply it onto the procedural base. Runs once at
/// room startup, before any command is processed, so the first joiner sees the restored world.
async fn restore_world(room: &mut Room, hub: &Hub) {
    let blob = match hub.db.load_world(&room.key().0).await {
        Ok(Some(blob)) => blob,
        Ok(None) => return,
        Err(e) => {
            tracing::error!(tenant = %room.key().0, error = %e, "failed to load world");
            return;
        }
    };
    match sim::decode_edits(&blob) {
        Ok(items) => {
            room.load_restored_edits(&items);
        }
        Err(e) => {
            tracing::error!(tenant = %room.key().0, error = %e, "failed to decode world blob")
        }
    }
}

async fn handle(room: &mut Room, hub: &Hub, now: Instant, cmd: RoomCmd) {
    match cmd {
        RoomCmd::Join {
            name,
            claim,
            look,
            ip,
            observer,
            conn,
            ping,
            reply,
        } => {
            on_join(
                room, hub, now, name, claim, look, ip, observer, conn, ping, reply,
            )
            .await
        }
        RoomCmd::Input { id, msg } => room.on_input(now, id, msg),
        RoomCmd::Leave { id, conn, clean } => room.on_leave(now, id, &conn, clean),
        RoomCmd::Rename {
            account_id,
            new_name,
            old_name,
        } => room.on_rename(&account_id, &new_name, &old_name),
        RoomCmd::Announce(msg) => room.broadcast(&msg),
    }
}

#[allow(clippy::too_many_arguments)]
async fn on_join(
    room: &mut Room,
    hub: &Hub,
    now: Instant,
    name: String,
    claim: String,
    look: Appearance,
    ip: IpAddr,
    observer: bool,
    conn: Conn,
    ping: Arc<AtomicU32>,
    reply: oneshot::Sender<Result<PlayerId, String>>,
) {
    // The ban is enforced in `admit`, after the claim resolves to a role, so a banned admin/moderator
    // is still admitted; only the role is unknown here.
    if room.is_full() {
        let _ = reply.send(Err("room_full".into()));
        return;
    }
    // Identity: an empty name+claim is an anonymous guest (the server names them). Otherwise the
    // claim TOKEN must resolve to an account in this tenant; the server adopts that account's
    // CURRENT name (authoritative), ignoring the name the client typed.
    let chosen = name.trim().to_string();
    let guest = chosen.is_empty() && claim.is_empty();
    if guest {
        return admit(
            room,
            hub,
            now,
            String::new(),
            String::new(),
            Role::Player,
            claim,
            look,
            ip,
            observer,
            conn,
            ping,
            reply,
        )
        .await;
    }
    let resolved = match hub.db.claim_to_account(&room.key().0, &claim).await {
        Ok(found) => found,
        Err(e) => {
            tracing::error!(tenant = %room.key().0, error = %e, "claim lookup failed");
            let _ = reply.send(Err("claim_required".into()));
            return;
        }
    };
    let Some((account_id, authoritative_name)) = resolved else {
        tracing::debug!(tenant = %room.key().0, "join rejected: claim required");
        let _ = reply.send(Err("claim_required".into()));
        return;
    };
    let live = hub.claims.is_live(&account_id, &claim);
    if !live {
        tracing::debug!(tenant = %room.key().0, "join rejected: claim required");
        let _ = reply.send(Err("claim_required".into()));
        return;
    }
    let role = hub.db.role(&account_id).await.unwrap_or_else(|e| {
        tracing::error!(tenant = %room.key().0, error = %e, "role lookup failed");
        Role::Player
    });
    admit(
        room,
        hub,
        now,
        account_id,
        authoritative_name,
        role,
        claim,
        look,
        ip,
        observer,
        conn,
        ping,
        reply,
    )
    .await;
}

/// Admit a join: resume a held slot, run the async db-backed policy, then (on a pass) add the
/// player. The split keeps every db read + gate in `resolve_admission` (the server I/O shell) and
/// the game-state mutation in the sync, db-free `add_player`; the reply is sent here so neither half
/// owns the channel. Order/outcomes are identical to the old single `admit`.
#[allow(clippy::too_many_arguments)]
async fn admit(
    room: &mut Room,
    hub: &Hub,
    now: Instant,
    account_id: String,
    authoritative_name: String,
    role: Role,
    claim: String,
    look: Appearance,
    ip: IpAddr,
    observer: bool,
    conn: Conn,
    ping: Arc<AtomicU32>,
    reply: oneshot::Sender<Result<PlayerId, String>>,
) {
    // Reconnect resume: a player whose socket dropped within RECONNECT_GRACE rejoins straight back
    // into their held slot (same id, position, score, inventory, hp) — no Left/Join churn, others
    // saw at most a brief freeze. They already cleared every gate at the original join, so resume
    // skips the policy entirely. Matched by identity: account for a logged-in player, IP for a guest.
    if let Some(id) = room.try_resume(now, &account_id, ip, &look, &conn, &ping) {
        let _ = reply.send(Ok(id));
        return;
    }
    let mut admission = match resolve_admission(
        room,
        hub,
        account_id,
        authoritative_name,
        role,
        claim,
        look,
        ip,
        ping,
    )
    .await
    {
        Ok(admission) => admission,
        Err(code) => {
            let _ = reply.send(Err(code));
            return;
        }
    };
    admission.observer = observer;
    let id = room.add_player(now, admission, conn);
    let _ = reply.send(Ok(id));
}

/// The async policy phase: all the db reads + gates, in the same order with the same outcomes as the
/// old `admit`, refreshing the cached per-tenant config on the room as it goes. Returns the rejection
/// code to reply, or a cleared-to-join `Admission` carrying everything the sync `add_player` needs
/// (including the pre-fetched timeline backlog and, for an admin, the pending-approval list). Does
/// NOT mutate game state.
#[allow(clippy::too_many_arguments)]
async fn resolve_admission(
    room: &mut Room,
    hub: &Hub,
    account_id: String,
    authoritative_name: String,
    role: Role,
    claim: String,
    look: Appearance,
    ip: IpAddr,
    ping: Arc<AtomicU32>,
) -> Result<Admission, String> {
    let (tenant, world) = room.key().clone();
    // Cross-instance room lease: before this instance serves the room it must hold the lease. With a
    // stable owner id this always succeeds for our own room (unheld -> take, ours -> keep, our stale
    // -> retake), so a single server never fails to serve itself; only a DIFFERENT live instance's
    // hold turns the join away with `served_elsewhere`. Two instances behind a load balancer can thus
    // never serve the same room at once.
    let acquired = hub
        .db
        .acquire_room_lease(
            &tenant,
            &world,
            &hub.owner,
            epoch_ms() as i64,
            LEASE_STALE_MS,
        )
        .await
        .unwrap_or(false);
    if !acquired {
        tracing::debug!(%tenant, %world, owner = %hub.owner, "join rejected: room served elsewhere");
        return Err("served_elsewhere".into());
    }
    // Role-aware ban gate: a banned IP is turned away here (the claim has resolved to a role) UNLESS
    // the account is an admin or moderator — they must still get in to moderate, even from a shared
    // home IP that someone got banned on. A banned guest/ordinary player stays refused.
    if hub.bans.is_banned(ip) && !role.is_admin() && !role.is_moderator() {
        return Err("banned".into());
    }
    // Refresh the per-tenant moderation flags + allowed modes from the db (this room is the single
    // writer, so the cache stays authoritative between joins).
    let (suspended, approval_required) =
        hub.db.tenant_flags(&tenant).await.unwrap_or((false, false));
    let (online_allowed, offline_allowed) =
        hub.db.tenant_modes(&tenant).await.unwrap_or((true, true));
    room.set_moderation_flags(suspended, approval_required);
    room.set_modes(online_allowed, offline_allowed);
    // Peace (monsters calm) is persisted so an admin who turned monsters ON keeps them on across a
    // room restart, instead of silently resetting to calm and looking like "monsters deal no damage".
    room.set_peace(hub.db.tenant_peace(&tenant).await.unwrap_or(true));
    // The other runtime admin toggles are persisted the same way, so they too survive a restart instead
    // of snapping back to defaults (pvp off / chat on / nothing blocked) and looking like they reverted.
    room.set_pvp(hub.db.tenant_pvp(&tenant).await.unwrap_or(false));
    room.set_chat_enabled(hub.db.tenant_chat_enabled(&tenant).await.unwrap_or(true));
    room.set_blocked_structures(
        hub.db
            .tenant_blocked_structures(&tenant)
            .await
            .unwrap_or_default(),
    );
    // Online play disabled for this tenant: reject the join (offline reaches the client only, gated
    // there). Admins still get in so they can re-enable it from the in-game panel. The reject reason
    // travels as the reply code; conn.rs turns it into the user-facing message (reject_message).
    if !room.online_allowed() && !role.is_admin() {
        return Err("online_blocked".into());
    }
    // A suspended world turns everyone away except admins, who still need to get in to resume it.
    if room.suspended() && !role.is_admin() {
        return Err("suspended".into());
    }
    // Approval gate (per-tenant, off by default): while on, admins always get in (to manage), and
    // everyone else — including anonymous guests, who do NOT have to log in — is held for approval.
    // The held player is keyed by account id, or by IP for a guest (same as playtime), recorded as
    // pending so the admins are notified; they approve in-game (and by email when there is one).
    if room.approval_required() && !role.is_admin() {
        let approval_key = playtime_key(&account_id, ip);
        // A reject is one-shot (expel, not ban): tell this attempt "rejected" and clear the request,
        // so a fresh join falls through to hold_for_approval below and the admins are re-notified.
        if hub
            .db
            .is_rejected(&tenant, &approval_key)
            .await
            .unwrap_or(false)
        {
            if let Err(e) = hub.db.clear_approval_request(&tenant, &approval_key).await {
                tracing::error!(error = %e, "clearing one-shot reject failed");
            }
            return Err("rejected".into());
        }
        if !hub
            .db
            .is_approved(&tenant, &approval_key)
            .await
            .unwrap_or(false)
        {
            let display_name = if authoritative_name.is_empty() {
                "Guest"
            } else {
                &authoritative_name
            };
            hold_for_approval(room, hub, &approval_key, display_name).await;
            return Err("needs_approval".into());
        }
    }
    // Play-time budget (per-tenant): cache the tenant's config and turn an over-budget player away
    // with "time_up". A logged-in player is keyed by account; an anonymous guest by their IP, so
    // their budget still accrues (in the same `playtime` table) across guest sessions.
    let (limit_min, window_h) = hub.db.tenant_playtime(&tenant).await.unwrap_or((0, 0));
    room.set_playtime(
        limit_min as u32,
        window_h as u32,
        limit_min * 60_000,
        window_h * 3_600_000,
    );
    let playtime_key = playtime_key(&account_id, ip);
    let mut playtime_baseline = 0;
    // Admins are never blocked by the play-time budget — even out of time they keep playing and can
    // run the lobby/in-game admin panel. Moderators and players ARE subject to it.
    if room.playtime_limit_ms() > 0 && !role.is_admin() {
        playtime_baseline = hub
            .db
            .playtime_used(
                &tenant,
                &playtime_key,
                room.playtime_window_ms(),
                epoch_ms() as i64,
            )
            .await
            .unwrap_or(0);
        if playtime_baseline >= room.playtime_limit_ms() {
            return Err("time_up".into());
        }
    }
    // Pre-fetch the recent-timeline backlog (replayed to this connection) here, so `add_player`
    // stays db-free. The legacy-report filter is applied at send time (it is pure).
    let backlog = match hub
        .db
        .recent_events(&tenant, crate::db::default_event_backlog())
        .await
    {
        Ok(events) => events
            .into_iter()
            .map(|e| BacklogEvent {
                kind: e.kind,
                name: e.name,
                detail: e.detail,
            })
            .collect(),
        Err(e) => {
            tracing::error!(tenant = %tenant, error = %e, "event backlog load failed");
            Vec::new()
        }
    };
    // An admin also gets the current pending-approval list (db-read) up front so `add_player` can
    // push it without awaiting; the ban list is built from the in-memory cache there. A failed read
    // yields `Some(None)` so the bans list is still sent, exactly as the old path did.
    let admin_pending = match role.is_admin() {
        true => Some(fetch_pending_for_admin(hub, &tenant).await),
        false => None,
    };
    Ok(Admission {
        account_id,
        name: authoritative_name,
        role,
        claim,
        look,
        ip,
        // The policy phase is identity-only; the caller (`admit`) sets this from the Join flag.
        observer: false,
        ping,
        playtime_key,
        playtime_baseline_ms: playtime_baseline,
        backlog,
        admin_pending,
    })
}

/// Record a held-out player (a logged-in account, or a guest keyed by IP) as pending, email the
/// tenant's admins, and refresh the in-game pending list for any online admin so they can approve
/// immediately. A guest has no account, so the request carries an empty email (admins are still
/// notified in-game + by the tenant-admin email).
async fn hold_for_approval(room: &Room, hub: &Hub, account_id: &str, name: &str) {
    let tenant = room.key().0.clone();
    let email = match hub.db.get_account_by_id(account_id).await {
        Ok(Some(account)) => account.email,
        Ok(None) => String::new(),
        Err(e) => {
            tracing::error!(error = %e, "approval hold: account lookup failed");
            return;
        }
    };
    if let Err(e) = hub
        .db
        .record_approval_request(&tenant, account_id, name, &email)
        .await
    {
        tracing::error!(error = %e, "approval request persist failed");
        return;
    }
    tracing::info!(tenant = %tenant, %account_id, "player held for approval");
    let db = hub.db.clone();
    let notify_tenant = tenant.clone();
    let player_name = name.to_string();
    tokio::spawn(async move {
        crate::notify::approval_request(&db, &notify_tenant, &player_name).await;
    });
    send_pending(&hub.db, &tenant, &room.admin_conns()).await;
}

/// Load the tenant's pending-approval list (wire-shaped) for an admin join, so the sync add can push
/// it without a db read. `None` mirrors the old send path's behavior on a failed read: skip the
/// PendingApprovals frame (the bans list is still sent by the caller).
async fn fetch_pending_for_admin(
    hub: &Hub,
    tenant: &str,
) -> Option<Vec<protocol::PendingApproval>> {
    match hub.db.pending_approvals(tenant).await {
        Ok(pending) => Some(
            pending
                .into_iter()
                .map(|p| protocol::PendingApproval {
                    account_id: p.account_id,
                    name: p.name,
                    email: p.email,
                })
                .collect(),
        ),
        Err(e) => {
            tracing::error!(error = %e, "pending approvals load failed");
            None
        }
    }
}

/// Load the tenant's pending-approval list and send it to each given (admin) connection.
async fn send_pending(db: &Db, tenant: &str, conns: &[Conn]) {
    if conns.is_empty() {
        return;
    }
    let pending = match db.pending_approvals(tenant).await {
        Ok(list) => list,
        Err(e) => {
            tracing::error!(error = %e, "pending approvals load failed");
            return;
        }
    };
    let wire: Vec<protocol::PendingApproval> = pending
        .into_iter()
        .map(|p| protocol::PendingApproval {
            account_id: p.account_id,
            name: p.name,
            email: p.email,
        })
        .collect();
    for conn in conns {
        conn.send(Outbound::One(protocol::ServerMsg::PendingApprovals {
            pending: wire.clone(),
        }));
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    use game_core::RoomConfig;
    use protocol::{ClientMsg, PlayerMeta, ServerMsg};
    use tokio::sync::mpsc;

    use crate::db::Db;
    use crate::hub::Hub;
    use crate::persistence::DbPersistence;
    use crate::room_io::NativeSink;

    /// A real room built exactly as `get_or_create_room` does — a fresh in-memory db + hub, the "acme"
    /// tenant config, a db-backed persistence and the `NativeRoomHost` — so the async admit policy runs
    /// against the genuine db/ban/claim state. Returns the room plus the hub the test reads/writes through.
    async fn test_room() -> (Room, Arc<Hub>) {
        let db = Arc::new(Db::memory().await);
        let hub = Arc::new(Hub::load(db).await);
        let tcfg = hub.tenants.get("acme").unwrap().clone();
        let config = RoomConfig {
            tenant: tcfg.id.clone(),
            world: "main".to_string(),
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
        let room = Room::new(
            config,
            Arc::new(DbPersistence::new(hub.db.clone())),
            Arc::new(NativeRoomHost { hub: hub.clone() }),
        );
        (room, hub)
    }

    /// Decode whatever a connection received back into a `ServerMsg`: a per-player `One` is unwrapped
    /// directly; a fan-out `Frame` is parsed back from the single JSON the room serialized once.
    fn unwrap_msg(out: Outbound) -> ServerMsg {
        match out {
            Outbound::One(msg) => msg,
            Outbound::Frame(frame) => serde_json::from_str(&frame).expect("valid broadcast frame"),
            Outbound::Binary(_) => {
                panic!("binary frames carry the snapshot only; assert on its bytes via broadcast_snapshot")
            }
        }
    }

    /// Receive the next message off a test connection as a decoded `ServerMsg` (see `unwrap_msg`).
    trait RecvMsg {
        fn try_recv_msg(&mut self) -> Result<ServerMsg, mpsc::error::TryRecvError>;
    }

    impl RecvMsg for mpsc::Receiver<Outbound> {
        fn try_recv_msg(&mut self) -> Result<ServerMsg, mpsc::error::TryRecvError> {
            self.try_recv().map(unwrap_msg)
        }
    }

    /// A `NativeSink` over a fresh channel, returning the sink the room holds plus the backing receiver the
    /// test reads off — the test-side mirror of `conn.rs` wiring a real socket to a `NativeSink`.
    fn test_conn() -> (Conn, mpsc::Receiver<Outbound>) {
        let (tx, rx) = mpsc::channel::<Outbound>(64);
        (Arc::new(NativeSink::new(tx)), rx)
    }

    /// Insert a minimal player into the room (via the game-core test-support seam) and return the channel
    /// that captures messages sent to it.
    fn add_player(room: &mut Room, id: PlayerId, is_admin: bool) -> mpsc::Receiver<Outbound> {
        let (conn, conn_rx) = test_conn();
        room.test_insert_player(id, is_admin, conn);
        conn_rx
    }

    /// The `you` id of the first Welcome a connection received (resume re-sends one), or None.
    fn first_welcome_id(rx: &mut mpsc::Receiver<Outbound>) -> Option<PlayerId> {
        std::iter::from_fn(|| rx.try_recv_msg().ok()).find_map(|m| match m {
            ServerMsg::Welcome { you, .. } => Some(you),
            _ => None,
        })
    }

    /// Whether any `Left { id }` for the given player was broadcast on this connection.
    fn saw_left(rx: &mut mpsc::Receiver<Outbound>, target: PlayerId) -> bool {
        std::iter::from_fn(|| rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Left { id } if id == target))
    }

    /// Drain a connection's queued frames as decoded rosters, skipping the binary snapshot frames a tick
    /// fans out (those carry no roster).
    fn drain_rosters(rx: &mut mpsc::Receiver<Outbound>) -> Vec<Vec<PlayerMeta>> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            if matches!(frame, Outbound::Binary(_)) {
                continue;
            }
            if let ServerMsg::Roster { players } = unwrap_msg(frame) {
                out.push(players);
            }
        }
        out
    }

    /// The LAST roster a connection received, if any.
    fn last_roster(rx: &mut mpsc::Receiver<Outbound>) -> Option<Vec<PlayerMeta>> {
        drain_rosters(rx).pop()
    }

    /// Count the roster frames a connection received (for the quiet-tick assertion).
    fn count_rosters(rx: &mut mpsc::Receiver<Outbound>) -> usize {
        drain_rosters(rx).len()
    }
    #[tokio::test]
    async fn admin_ban_bans_the_ip_and_removes_target() {
        // The ban store is db-backed (each test_room has its own in-memory db), so there is nothing to
        // point at a throwaway file anymore.
        let (mut room, hub) = test_room().await;
        let _admin_rx = add_player(&mut room, 1, true);
        let _target_rx = add_player(&mut room, 2, false);
        let target_ip: IpAddr = "203.0.113.9".parse().unwrap();
        room.test_set_player_ip(2, target_ip);

        room.on_input(Instant::now(), 1, ClientMsg::AdminBan { id: 2 });
        assert!(
            !room.test_players_contains(2),
            "the banned player is removed"
        );
        assert!(hub.bans.is_banned(target_ip), "the ip is banned");
    }

    #[tokio::test]
    async fn a_banned_ip_still_admits_an_admin_or_moderator_but_refuses_a_player() {
        // A ban targets an IP. If a parent (admin) or helper (moderator) shares that banned address, they
        // must still get in to moderate; only an ordinary player from it stays refused.
        let (mut room, hub) = test_room().await;
        let banned_ip = "203.0.113.50";
        hub.bans.ban(banned_ip.parse().unwrap(), "someone".into());

        let (admin_result, _a) =
            admit_from_ip(&mut room, &hub, "acc-a", "Parent", Role::Admin, banned_ip).await;
        assert!(admin_result.is_ok(), "a banned IP still admits an admin");
        let (mod_result, _m) = admit_from_ip(
            &mut room,
            &hub,
            "acc-m",
            "Helper",
            Role::Moderator,
            banned_ip,
        )
        .await;
        assert!(mod_result.is_ok(), "a banned IP still admits a moderator");
        let (player_result, _p) =
            admit_from_ip(&mut room, &hub, "acc-p", "Kid", Role::Player, banned_ip).await;
        assert_eq!(
            player_result,
            Err("banned".into()),
            "a banned IP still refuses an ordinary player"
        );
    }

    #[tokio::test]
    async fn admin_ban_refuses_to_ban_an_admin_or_moderator() {
        // Banning staff is refused (a kick still works): an admin or moderator target is never banned, so
        // a ban can't lock a fellow grown-up/helper out. A normal player is still bannable.
        let (mut room, hub) = test_room().await;
        let _admin_rx = add_player(&mut room, 1, true);

        let admin_target_ip: IpAddr = "203.0.113.71".parse().unwrap();
        let _admin_target_rx = add_player(&mut room, 2, true);
        room.test_set_player_ip(2, admin_target_ip);
        room.on_input(Instant::now(), 1, ClientMsg::AdminBan { id: 2 });
        assert!(
            room.test_players_contains(2),
            "an admin target is not removed"
        );
        assert!(
            !hub.bans.is_banned(admin_target_ip),
            "an admin target's ip is never banned"
        );

        let mod_target_ip: IpAddr = "203.0.113.72".parse().unwrap();
        let _mod_target_rx = add_player(&mut room, 3, false);
        room.test_set_player_moderator(3, true);
        room.test_set_player_ip(3, mod_target_ip);
        room.on_input(Instant::now(), 1, ClientMsg::AdminBan { id: 3 });
        assert!(
            room.test_players_contains(3),
            "a moderator target is not removed"
        );
        assert!(
            !hub.bans.is_banned(mod_target_ip),
            "a moderator target's ip is never banned"
        );

        let player_target_ip: IpAddr = "203.0.113.73".parse().unwrap();
        let _player_target_rx = add_player(&mut room, 4, false);
        room.test_set_player_ip(4, player_target_ip);
        room.on_input(Instant::now(), 1, ClientMsg::AdminBan { id: 4 });
        assert!(
            !room.test_players_contains(4),
            "a normal player is still banned"
        );
        assert!(
            hub.bans.is_banned(player_target_ip),
            "a normal player's ip is banned"
        );
    }

    #[tokio::test]
    async fn guest_joins_without_a_claim_and_gets_a_unique_name() {
        let (mut room, hub) = test_room().await;
        let (conn, _conn_rx) = test_conn();
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        on_join(
            &mut room,
            &hub,
            Instant::now(),
            String::new(),
            String::new(),
            look,
            "127.0.0.1".parse().unwrap(),
            false,
            conn,
            Arc::new(AtomicU32::new(0)),
            reply,
        )
        .await;
        let id = reply_rx
            .await
            .unwrap()
            .expect("a guest joins with no claim");
        assert_eq!(room.test_player_name(id), format!("Guest{id}"));
        assert!(room.test_player_account_empty(id), "a guest has no account");
    }

    /// Drive `admit` for a logged-in account with the given id/name/role and return its outcome plus
    /// the captured connection. Mirrors the on_join → admit path without the claim resolution.
    async fn admit_account(
        room: &mut Room,
        hub: &Hub,
        account_id: &str,
        name: &str,
        role: Role,
    ) -> (Result<PlayerId, String>, mpsc::Receiver<Outbound>) {
        let (conn, conn_rx) = test_conn();
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        admit(
            room,
            hub,
            Instant::now(),
            account_id.to_string(),
            name.to_string(),
            role,
            "claim".into(),
            look,
            "127.0.0.1".parse().unwrap(),
            false,
            conn,
            Arc::new(AtomicU32::new(0)),
            reply,
        )
        .await;
        (reply_rx.await.unwrap(), conn_rx)
    }

    #[tokio::test]
    async fn approval_off_by_default_lets_everyone_in() {
        let (mut room, hub) = test_room().await;
        let acc = hub
            .db
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;
        let (result, _rx) = admit_account(&mut room, &hub, &acc, "Kid", Role::Player).await;
        assert!(result.is_ok(), "approval off admits a normal player");
    }

    #[tokio::test]
    async fn approval_required_refuses_unapproved_then_admits_after_approve() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_approval_required(&room.key().0, true)
            .await
            .unwrap();
        let acc = hub
            .db
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;

        let (refused, _rx) = admit_account(&mut room, &hub, &acc, "Kid", Role::Player).await;
        assert_eq!(refused, Err("needs_approval".into()));
        // The held-out account is now pending.
        let pending = hub.db.pending_approvals("acme").await.unwrap();
        assert_eq!(pending.len(), 1);

        // After an admin approves it, the same account is admitted.
        hub.db.approve_account("acme", &acc).await.unwrap();
        let (allowed, _rx2) = admit_account(&mut room, &hub, &acc, "Kid", Role::Player).await;
        assert!(allowed.is_ok(), "an approved account is admitted");
    }

    #[tokio::test]
    async fn approval_required_always_admits_admins() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_approval_required(&room.key().0, true)
            .await
            .unwrap();
        let acc = hub
            .db
            .claim_account("acme", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        let (result, _rx) = admit_account(&mut room, &hub, &acc, "Parent", Role::Admin).await;
        assert!(result.is_ok(), "an admin is never held out by the gate");
        assert!(
            hub.db.pending_approvals("acme").await.unwrap().is_empty(),
            "an admin never becomes a pending request"
        );
    }

    #[tokio::test]
    async fn approval_required_holds_an_anonymous_guest_then_admits_after_approve() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_approval_required(&room.key().0, true)
            .await
            .unwrap();
        // An anonymous guest (no account, no login) is HELD for approval — never told to log in.
        let (held, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.50").await;
        assert_eq!(
            held,
            Err("needs_approval".into()),
            "a guest waits for approval instead of being asked to log in"
        );
        // Recorded as pending, keyed by IP so the admin can approve it.
        let pending = hub.db.pending_approvals(&room.key().0).await.unwrap();
        assert_eq!(pending.len(), 1);
        // After the admin approves that IP key, the same guest is admitted on retry.
        hub.db
            .approve_account(&room.key().0, "ip:203.0.113.50")
            .await
            .unwrap();
        let (allowed, _rx2) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.50").await;
        assert!(allowed.is_ok(), "an approved guest is admitted");
    }

    #[tokio::test]
    async fn holding_a_guest_broadcasts_pending_approvals_to_in_game_admins() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_approval_required(&room.key().0, true)
            .await
            .unwrap();
        // An admin is already in the room (the in-game admin who must get the live notification).
        let mut admin_rx = add_player(&mut room, 1, true);
        // A guest joins and is held for approval.
        let (held, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.60").await;
        assert_eq!(held, Err("needs_approval".into()));
        // The held guest's persist + broadcast is awaited inline by hold_for_approval, so the admin's
        // connection already carries the refreshed pending list with the waiting guest.
        let pending = std::iter::from_fn(|| admin_rx.try_recv_msg().ok()).find_map(|m| match m {
            ServerMsg::PendingApprovals { pending } => Some(pending),
            _ => None,
        });
        let pending = pending.expect("the in-game admin is notified with the pending list");
        assert_eq!(
            pending.len(),
            1,
            "the held guest appears in the pending list"
        );
    }

    #[tokio::test]
    async fn reject_is_one_shot_then_a_fresh_join_is_held_again() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_approval_required(&room.key().0, true)
            .await
            .unwrap();
        let acc = hub
            .db
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;
        // The admin rejected the held request: the next join is told "rejected" exactly once.
        hub.db
            .record_approval_request("acme", &acc, "Kid", "kid@x.com")
            .await
            .unwrap();
        hub.db.reject_approval_request("acme", &acc).await.unwrap();

        let (rejected, _rx) = admit_account(&mut room, &hub, &acc, "Kid", Role::Player).await;
        assert_eq!(
            rejected,
            Err("rejected".into()),
            "the rejected attempt ends"
        );
        assert!(
            !hub.db.is_rejected("acme", &acc).await.unwrap(),
            "the one-shot reject is cleared so a fresh join is not stuck on rejected"
        );

        // A fresh join is held for approval again, re-recording the pending row (admins re-notified).
        let (held, _rx2) = admit_account(&mut room, &hub, &acc, "Kid", Role::Player).await;
        assert_eq!(
            held,
            Err("needs_approval".into()),
            "the next join is held for approval, not turned away forever"
        );
        let pending = hub.db.pending_approvals("acme").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].account_id, acc);
    }

    #[tokio::test]
    async fn banning_a_pending_player_bans_the_ip_and_drops_the_request() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_approval_required(&room.key().0, true)
            .await
            .unwrap();
        let mut admin_rx = add_player(&mut room, 1, true);
        // A held guest, recorded as pending by their IP key.
        let (held, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.77").await;
        assert_eq!(held, Err("needs_approval".into()));
        assert_eq!(hub.db.pending_approvals("acme").await.unwrap().len(), 1);

        room.on_input(
            Instant::now(),
            1,
            ClientMsg::AdminBanPending {
                account_id: "ip:203.0.113.77".into(),
            },
        );
        // The ip ban is applied synchronously; the request clear is spawned, so let it run.
        let banned_ip: IpAddr = "203.0.113.77".parse().unwrap();
        assert!(hub.bans.is_banned(banned_ip), "the pending ip is banned");
        for _ in 0..50 {
            if hub.db.pending_approvals("acme").await.unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            hub.db.pending_approvals("acme").await.unwrap().is_empty(),
            "the banned player is removed from the pending list"
        );

        // The banned address is now turned away at the join gate (the same check the connect path runs).
        let (conn, _conn_rx) = test_conn();
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        on_join(
            &mut room,
            &hub,
            Instant::now(),
            String::new(),
            String::new(),
            look,
            banned_ip,
            false,
            conn,
            Arc::new(AtomicU32::new(0)),
            reply,
        )
        .await;
        assert_eq!(reply_rx.await.unwrap(), Err("banned".into()));
        // The admin who acted received the refreshed ban list.
        let saw_bans = std::iter::from_fn(|| admin_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Bans { .. }));
        assert!(saw_bans, "the admin gets the refreshed ban list");
    }

    #[tokio::test]
    async fn ban_pending_never_bans_an_account_keyed_target() {
        // Ban-pending only ever targets a guest by their `ip:<addr>` key. An account-keyed entry — the
        // only way a target could resolve to an admin/moderator — is never banned through this path, so
        // staff stay safe even if a client sends an account id.
        let (mut room, hub) = test_room().await;
        let _admin_rx = add_player(&mut room, 1, true);
        let acc = hub
            .db
            .claim_account("acme", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        hub.db
            .set_admin_by_name("acme", "Parent", true)
            .await
            .unwrap();

        room.on_input(
            Instant::now(),
            1,
            ClientMsg::AdminBanPending {
                account_id: acc.clone(),
            },
        );
        let before = hub.bans.list_named().len();
        assert_eq!(before, 0, "an account-keyed ban-pending adds no ban");
    }

    #[tokio::test]
    async fn admin_toggles_approval_and_approves_a_pending_account() {
        let (mut room, hub) = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let acc = hub
            .db
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;

        room.on_input(Instant::now(), 1, ClientMsg::AdminSetApproval { on: true });
        assert!(room.approval_required());
        let required = std::iter::from_fn(|| admin_rx.try_recv_msg().ok()).find_map(|m| match m {
            ServerMsg::RoomState {
                approval_required, ..
            } => Some(approval_required),
            _ => None,
        });
        assert_eq!(required, Some(true), "the toggle broadcasts RoomState");

        hub.db
            .record_approval_request("acme", &acc, "Kid", "kid@x.com")
            .await
            .unwrap();
        room.on_input(
            Instant::now(),
            1,
            ClientMsg::AdminApprove {
                account_id: acc.clone(),
            },
        );
        // The approve is spawned async; let it run, then confirm the account is approved + cleared.
        tokio::task::yield_now().await;
        for _ in 0..50 {
            if hub.db.is_approved("acme", &acc).await.unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(hub.db.is_approved("acme", &acc).await.unwrap());
        assert!(hub.db.pending_approvals("acme").await.unwrap().is_empty());
    }

    /// Admit a guest/account from a chosen IP, so the play-time + mode-block paths can be exercised.
    async fn admit_from_ip(
        room: &mut Room,
        hub: &Hub,
        account_id: &str,
        name: &str,
        role: Role,
        ip: &str,
    ) -> (Result<PlayerId, String>, mpsc::Receiver<Outbound>) {
        let (conn, conn_rx) = test_conn();
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        admit(
            room,
            hub,
            Instant::now(),
            account_id.to_string(),
            name.to_string(),
            role,
            "claim".into(),
            look,
            ip.parse().unwrap(),
            false,
            conn,
            Arc::new(AtomicU32::new(0)),
            reply,
        )
        .await;
        (reply_rx.await.unwrap(), conn_rx)
    }

    fn first_error_code(rx: &mut mpsc::Receiver<Outbound>) -> Option<String> {
        std::iter::from_fn(|| rx.try_recv_msg().ok()).find_map(|m| match m {
            ServerMsg::Error { code, .. } => Some(code),
            _ => None,
        })
    }

    #[tokio::test]
    async fn a_drop_then_resume_each_broadcast_an_away_toggled_roster() {
        let (mut room, hub) = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _dropped_rx = add_player(&mut room, 2, false);
        let conn2 = room.test_player_conn(2);
        // An abrupt drop marks the slot away=true and refreshes the roster (no Left during grace).
        room.on_leave(Instant::now(), 2, &conn2, false);
        let away = last_roster(&mut peer_rx).expect("a drop refreshes the roster");
        assert!(
            away.iter().find(|p| p.id == 2).unwrap().away,
            "the dropped player shows away in the roster",
        );
        // A reconnect resumes the held slot and refreshes the roster with away=false again.
        let (resumed, _r2) =
            admit_from_ip(&mut room, &hub, "acc2", "p2", Role::Player, "127.0.0.1").await;
        assert_eq!(resumed, Ok(2), "the slot resumes");
        let back = last_roster(&mut peer_rx).expect("a resume refreshes the roster");
        assert!(
            !back.iter().find(|p| p.id == 2).unwrap().away,
            "the resumed player is no longer away",
        );
    }

    #[tokio::test]
    async fn the_roster_is_not_rebroadcast_on_a_quiet_tick() {
        let (mut room, hub) = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        add_player(&mut room, 2, false);
        // Both players hold a live claim so the reclaim-kick sweep leaves them in place: the stretch is
        // genuinely quiet (no leave/kick), exercising the path that used to re-send the roster.
        hub.claims.set("acc1", "tok1");
        hub.claims.set("acc2", "tok2");
        // No roster-affecting change happens — just advance many ticks past several STATUS_EVERY_TICKS
        // boundaries. The roster used to be re-sent every boundary; now a quiet tick emits none.
        let _ = last_roster(&mut peer_rx); // ignore anything queued before the quiet stretch
        for _ in 0..(Room::test_status_every_ticks() * 4 + 3) {
            room.tick_at(Instant::now(), 0.05);
        }
        assert!(
            room.test_players_contains(1) && room.test_players_contains(2),
            "both players stay through the quiet stretch (no leave/kick)",
        );
        assert_eq!(
            count_rosters(&mut peer_rx),
            0,
            "a quiet stretch of ticks broadcasts no roster",
        );
    }

    #[tokio::test]
    async fn the_grace_prune_broadcasts_an_updated_roster() {
        let (mut room, hub) = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _dropped_rx = add_player(&mut room, 2, false);
        let conn2 = room.test_player_conn(2);
        room.on_leave(Instant::now(), 2, &conn2, false);
        room.test_backdate_disconnect(2, Room::test_reconnect_grace() + Duration::from_secs(1));
        // Keep the observing peer alive through the sweep: register its claim so the reclaim-kick (which
        // fires for any account whose live claim isn't in the hub) leaves it in place to see the prune.
        hub.claims.set("acc1", "tok1");
        let _ = last_roster(&mut peer_rx); // clear the drop's roster
        room.test_set_tick(Room::test_status_every_ticks() - 1);
        room.tick_at(Instant::now(), 0.05);
        let roster = last_roster(&mut peer_rx).expect("the prune refreshes the roster");
        assert_eq!(roster.len(), 1, "the pruned player leaves the roster");
        assert!(roster.iter().all(|p| p.id != 2), "the pruned slot is gone");
    }

    #[tokio::test]
    async fn a_rejoin_within_grace_resumes_the_same_slot_intact() {
        let (mut room, hub) = test_room().await;
        // A guest joins from an IP, builds up score + inventory, then their socket drops.
        let (admitted, mut first_rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.7").await;
        let id = admitted.expect("guest admitted");
        room.test_set_player_pos(id, 12.0, 34.0, 56.0);
        room.test_set_player_score(id, 7);
        room.test_set_player_hp(id, 2);
        room.test_set_player_inventory(id, 3, 9);
        let dropped_conn = room.test_player_conn(id);
        room.on_leave(Instant::now(), id, &dropped_conn, false);
        assert!(room.test_player_disconnected(id));

        // The same guest rejoins (same IP) within the grace.
        let (resumed, mut second_rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.7").await;
        assert_eq!(resumed, Ok(id), "the rejoin resumes the same player id");
        assert_eq!(room.test_players_len(), 1, "no duplicate slot is created");
        assert!(!room.test_player_disconnected(id), "the slot is live again");
        assert_eq!(
            room.test_player_pos(id),
            [12.0, 34.0, 56.0],
            "position is intact"
        );
        assert_eq!(room.test_player_score(id), 7, "score is intact");
        assert_eq!(room.test_player_hp(id), 2, "hp is intact");
        assert_eq!(
            room.test_player_inventory(id, 3),
            Some(9),
            "inventory is intact"
        );
        // The resuming connection gets a Welcome for the SAME id; no Left was ever broadcast.
        assert_eq!(first_welcome_id(&mut second_rx), Some(id));
        assert!(
            !saw_left(&mut first_rx, id),
            "resume causes no Left/Join churn"
        );
    }

    #[tokio::test]
    async fn an_authed_player_resumes_by_account_not_ip() {
        let (mut room, hub) = test_room().await;
        // A logged-in player on one IP drops; they reconnect from a DIFFERENT IP (e.g. wifi → cellular).
        let (admitted, _first_rx) = admit_from_ip(
            &mut room,
            &hub,
            "acc-jo",
            "Jo",
            Role::Player,
            "198.51.100.1",
        )
        .await;
        let id = admitted.expect("authed player admitted");
        let dropped_conn = room.test_player_conn(id);
        room.on_leave(Instant::now(), id, &dropped_conn, false);
        let (resumed, _second_rx) =
            admit_from_ip(&mut room, &hub, "acc-jo", "Jo", Role::Player, "203.0.113.9").await;
        assert_eq!(
            resumed,
            Ok(id),
            "the account resumes its slot across an IP change"
        );
        assert_eq!(room.test_players_len(), 1, "no duplicate slot");
    }

    #[tokio::test]
    async fn anonymous_playtime_accrues_by_ip_and_kicks_with_time_up() {
        let (mut room, hub) = test_room().await;
        // A 1-minute budget within a 24h window for this tenant.
        hub.db
            .set_tenant_playtime(&room.key().0, 1, 24)
            .await
            .unwrap();
        // An anonymous guest (empty account id) joins from a known IP.
        let (admitted, mut rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.7").await;
        let id = admitted.expect("a guest within budget is admitted");
        // Pretend the session started two minutes ago, past the 1-minute budget.
        let two_min_ms = 2 * 60_000u64;
        room.test_set_player_joined_at_ms(id, Room::test_epoch_ms() - two_min_ms);
        // The status sweep flushes the time and sends the over-budget guest to the lobby.
        room.test_set_tick(Room::test_status_every_ticks() - 1);
        room.tick_at(Instant::now(), 0.05);
        assert_eq!(first_error_code(&mut rx).as_deref(), Some("time_up"));
        assert!(!room.test_players_contains(id), "the guest is removed");
        // The accrual write is fire-and-forget (spawned off the tick), so let it land before reading.
        let mut used = 0;
        for _ in 0..50 {
            tokio::task::yield_now().await;
            used = hub
                .db
                .playtime_used(
                    &room.key().0,
                    "ip:203.0.113.7",
                    24 * 3_600_000,
                    Room::test_epoch_ms() as i64,
                )
                .await
                .unwrap();
            if used >= 60_000 {
                break;
            }
        }
        assert!(used >= 60_000, "anonymous time accrued by IP, got {used}ms");
        // The IP is now over budget, so the next guest from it is turned away with "time_up".
        let (blocked, _rx2) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.7").await;
        assert_eq!(blocked, Err("time_up".into()), "the IP is over budget");
    }

    #[tokio::test]
    async fn an_admin_over_the_playtime_budget_still_plays_but_a_moderator_does_not() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_playtime(&room.key().0, 1, 24)
            .await
            .unwrap();
        // Burn the IP's budget: a guest plays 2 minutes, past the 1-minute limit.
        let (admitted, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.9").await;
        let id = admitted.expect("first guest admitted");
        room.test_set_player_joined_at_ms(id, Room::test_epoch_ms() - 2 * 60_000);
        room.test_set_tick(Room::test_status_every_ticks() - 1);
        room.tick_at(Instant::now(), 0.05);
        for _ in 0..50 {
            tokio::task::yield_now().await;
            let used = hub
                .db
                .playtime_used(
                    &room.key().0,
                    "ip:203.0.113.9",
                    24 * 3_600_000,
                    Room::test_epoch_ms() as i64,
                )
                .await
                .unwrap();
            if used >= 60_000 {
                break;
            }
        }
        // A moderator from that over-budget IP is turned away — moderators are subject to the limit.
        let (mod_res, _r1) =
            admit_from_ip(&mut room, &hub, "", "", Role::Moderator, "203.0.113.9").await;
        assert_eq!(
            mod_res,
            Err("time_up".into()),
            "a moderator over budget is blocked"
        );
        // An admin from the same over-budget IP still gets in.
        let (admin_res, _r2) =
            admit_from_ip(&mut room, &hub, "", "", Role::Admin, "203.0.113.9").await;
        let admin_id = admin_res.expect("an admin over budget still plays");
        // And an admin already past their session time is never kicked by the play-time sweep.
        room.test_set_player_joined_at_ms(admin_id, Room::test_epoch_ms() - 5 * 60_000);
        room.test_set_tick(Room::test_status_every_ticks() - 1);
        room.tick_at(Instant::now(), 0.05);
        assert!(
            room.test_players_contains(admin_id),
            "an admin is never kicked by the playtime sweep"
        );
    }

    #[tokio::test]
    async fn a_room_held_by_another_live_instance_rejects_the_join_with_served_elsewhere() {
        let (mut room, hub) = test_room().await;
        let (tenant, world) = room.key().clone();
        // Another instance already holds this room's lease, fresh right now.
        assert!(hub
            .db
            .acquire_room_lease(
                &tenant,
                &world,
                "other-instance",
                epoch_ms() as i64,
                LEASE_STALE_MS
            )
            .await
            .unwrap());
        let (refused, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.9").await;
        assert_eq!(
            refused,
            Err("served_elsewhere".into()),
            "a room served by another live instance turns the join away"
        );
    }

    #[tokio::test]
    async fn this_instance_acquires_its_own_lease_and_admits() {
        let (mut room, hub) = test_room().await;
        let (tenant, world) = room.key().clone();
        // No lease yet: a join takes the lease for THIS instance and is admitted.
        let (admitted, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.9").await;
        assert!(admitted.is_ok(), "this instance serves its own room");
        // The lease is now ours; a foreign instance is refused while we hold it.
        assert!(!hub
            .db
            .acquire_room_lease(
                &tenant,
                &world,
                "other-instance",
                epoch_ms() as i64,
                LEASE_STALE_MS
            )
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn online_blocked_rejects_a_non_admin_join_but_admits_admins() {
        let (mut room, hub) = test_room().await;
        hub.db
            .set_tenant_modes(&room.key().0, false, true)
            .await
            .unwrap();
        let (refused, _rx) =
            admit_from_ip(&mut room, &hub, "", "", Role::Player, "203.0.113.9").await;
        assert_eq!(refused, Err("online_blocked".into()));
        // An admin still gets in so they can re-enable online play from the panel.
        let acc = hub
            .db
            .claim_account("acme", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        let (allowed, _rx) =
            admit_from_ip(&mut room, &hub, &acc, "Parent", Role::Admin, "203.0.113.9").await;
        assert!(allowed.is_ok(), "an admin is admitted to manage the world");
    }
}
