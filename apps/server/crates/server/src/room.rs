//! One authoritative room per (tenant, world). Runs a fixed-rate tick, owns the world
//! state, validates every client input, and broadcasts snapshots. The server is the
//! single source of truth; clients predict locally and reconcile from snapshots.

use std::collections::{BTreeSet, HashMap};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{
    Brand, ClientMsg, CreatureState, EditCell, EditOp, InventoryItem, PlayerId, PlayerMeta,
    PlayerState, ServerMsg,
};
use sim::World;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::creatures::{Creature, CreatureKind};
use crate::db::Role;
use crate::hub::{Hub, PlayerInfo, RoomKey, RoomSnapshot, TenantCfg};

// Bulk edits (magic structures, and the world handed to a joining player) are capped so one player
// cannot flood the room or build across the whole map.
const MAX_BATCH_EDITS: usize = 8192;
const BATCH_RADIUS: f32 = 48.0;
// Cells per outgoing EditBatch frame, matching the client; keeps each message under the text cap.
const BATCH_CHUNK_SIZE: usize = 256;

// --- Creatures ---
// The live population scales with how many players are around (so everyone has creatures nearby) but
// stays within a floor and a hard ceiling that keeps the tick cheap. As creatures die or wander off,
// the deficit is refilled in small batches so an area with players never runs dry.
const CREATURES_PER_PLAYER: usize = 10;
const MIN_CREATURES: usize = 12;
const MAX_CREATURES: usize = 48;
const SPAWN_BATCH: usize = 4;
// Spawn new creatures within this horizontal radius of a player, and despawn any beyond DESPAWN_RADIUS.
const SPAWN_RADIUS: f32 = 28.0;
const DESPAWN_RADIUS: f32 = 64.0;
// Top the population up this often (refilling up to SPAWN_BATCH each time for fast recovery after kills).
const SPAWN_EVERY_TICKS: u64 = 5;
// A player must be within this distance of a creature for a Hit to land (anti-cheat melee range). Kept
// at/above the client's aim reach (REACH = 7) so a hit the client lets you land is never silently
// rejected here — that mismatch was why creatures "wouldn't die" when struck from a few blocks away.
const MELEE_RANGE: f32 = 8.0;
// Player health + how a hostile creature bites it. Mirrors the web rules (MAX_HEARTS, hurt.ts, the 1.2s
// hurt cooldown) so survival is identical, only now owned by the server.
const MAX_HP: u8 = 3;
const HURT_COOLDOWN: Duration = Duration::from_millis(1200);
const HURT_RANGE: f32 = 1.2;
const HURT_LEVEL_SLACK: f32 = 0.5;
const PLAYER_EYE_HEIGHT: f32 = 1.55;
const PLAYER_BODY_HEIGHT: f32 = 1.7;
// Taps on the same block before the server breaks it — digging takes a little effort, enforced server-side.
const DIG_HITS: u8 = 4;

/// Cosmetic look a player picks before joining (validated server-side, broadcast to everyone).
pub struct Appearance {
    pub skin: String,
    pub shirt: String,
    pub hair: String,
}

pub enum RoomCmd {
    Join {
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    },
    Input {
        id: PlayerId,
        msg: ClientMsg,
    },
    Leave {
        id: PlayerId,
    },
    /// A logged-in account renamed itself: update the live player and broadcast the timeline event.
    Rename {
        account_id: String,
        new_name: String,
        old_name: String,
    },
    /// Push a server-originated message to everyone in the room (e.g. a shutdown notice on SIGTERM).
    Announce(ServerMsg),
}

/// Simple token bucket; refilled every tick, spent per accepted message.
struct Bucket {
    tokens: f32,
    cap: f32,
    refill_per_sec: f32,
}

impl Bucket {
    fn new(rate: f32) -> Self {
        Self {
            tokens: rate,
            cap: rate,
            refill_per_sec: rate,
        }
    }
    fn refill(&mut self, dt: f32) {
        self.tokens = (self.tokens + self.refill_per_sec * dt).min(self.cap);
    }
    fn take(&mut self) -> bool {
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

struct Player {
    id: PlayerId,
    name: String,
    // The stable account this player is logged in as (empty for an anonymous guest) and the live
    // session token that proves it. Together they let the tick loop kick a player whose claim was
    // taken over (keyed by account_id, so the name can change underneath without losing the session).
    account_id: String,
    is_admin: bool,
    is_moderator: bool,
    claim: String,
    skin: String,
    shirt: String,
    hair: String,
    ip: IpAddr,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    pitch: f32,
    ping_ms: u32,
    score: u32,
    conn: mpsc::Sender<ServerMsg>,
    last_seen: Instant,
    last_move: Instant,
    // False until the player's first in-world move is accepted. That first move is taken verbatim as the
    // anti-cheat baseline (the client spawns/restores wherever it likes); only later moves are speed-checked.
    move_synced: bool,
    // Server-owned health: hearts left, and when the player last took damage (for the hurt cooldown).
    hp: u8,
    hurt_at: Instant,
    // The block currently being chipped and how many taps have landed, so the server decides the break.
    dig_block: Option<[i32; 3]>,
    dig_hits: u8,
    // Play-time accounting: the account's used time before this session, and how much of this session
    // has already been persisted (so the periodic flush only writes the new delta).
    playtime_baseline_ms: i64,
    playtime_persisted_ms: i64,
    // Server-authoritative block resources: a count per block id, banked on a break and spent on a
    // place. `infinite` (default on, to match the old client) lets a player build without spending.
    inventory: HashMap<u8, u32>,
    infinite: bool,
    joined_at_ms: u64,
    ping_nonce: u32,
    ping_sent_at: Instant,
    move_b: Bucket,
    edit_b: Bucket,
    chat_b: Bucket,
}

pub struct Room {
    hub: Arc<Hub>,
    key: RoomKey,
    brand: Brand,
    tick_hz: u32,
    max_players: usize,
    world: World,
    players: HashMap<PlayerId, Player>,
    rx: mpsc::Receiver<RoomCmd>,
    tick: u64,
    empty_since: Option<Instant>,
    dirty: bool,
    // Room-wide settings an admin controls: peace calms monsters for everyone; blocked_structures
    // gate the in-game build menu. A sorted set keeps the broadcast list deterministic.
    peace: bool,
    blocked_structures: BTreeSet<String>,
    // Player-vs-player combat (default off) and the room chat (default on), both admin-controlled.
    pvp: bool,
    chat_enabled: bool,
    // Server-authoritative creature population and the monotonic id counter that names each one.
    creatures: Vec<Creature>,
    next_creature_id: u32,
    // Per-tenant play-time budget, cached from the db on the first join (0 = unlimited). A logged-in
    // account that exceeds `playtime_limit_ms` within `playtime_window_ms` is sent to the lobby.
    playtime_limit_ms: i64,
    playtime_window_ms: i64,
    // Per-tenant moderation flags, cached from the `tenants` row (refreshed on join, written through on
    // toggle). This room is the only writer for its tenant, so the cache is authoritative at runtime.
    suspended: bool,
    approval_required: bool,
}

/// The server build identifier shown in the in-game debug panel: the deploy's `GIT_SHA` when set,
/// otherwise the crate version baked in at compile time.
fn server_version() -> String {
    std::env::var("GIT_SHA").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string())
}

/// Which per-tenant moderation flag a write-through targets.
enum TenantFlag {
    Suspended,
    ApprovalRequired,
}

const PING_EVERY_TICKS: u64 = 60; // 2s @ 30Hz
                                  // The ban/reclaim/idle sweep + admin telemetry don't need 30Hz; running them at ~2Hz keeps the hot tick
                                  // loop cheap (no per-tick DashMap lookups or player clones) without users noticing the slower cadence.
const STATUS_EVERY_TICKS: u64 = 15; // 0.5s @ 30Hz
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30);
const PERSIST_SECS: u64 = 10; // flush the world diff at most this often, only when dirty
                              // Snapshot coordinates are rounded to centimeter precision before going on the wire: full f32
                              // precision bloats every number with digits the client can't perceive (interpolation is fine at 1cm).
const SNAPSHOT_DECIMALS: f32 = 100.0;

impl Room {
    pub fn new(
        hub: Arc<Hub>,
        tcfg: &TenantCfg,
        world: String,
        rx: mpsc::Receiver<RoomCmd>,
    ) -> Self {
        let brand = Brand {
            name: tcfg.name.clone(),
            image: tcfg.image.clone(),
        };
        // The saved world is restored asynchronously in run() (a db read can't happen in this sync
        // constructor); start from the procedural base.
        let world_state = World::new();
        Self {
            key: (tcfg.id.clone(), world),
            brand,
            tick_hz: hub.limits.tick_hz,
            max_players: hub.limits.max_players_per_room,
            world: world_state,
            players: HashMap::new(),
            rx,
            tick: 0,
            empty_since: Some(Instant::now()),
            dirty: false,
            // Monsters are calm by default (kids' worlds); an admin/moderator turns attacks on.
            peace: true,
            blocked_structures: BTreeSet::new(),
            pvp: false,
            chat_enabled: true,
            creatures: Vec::new(),
            next_creature_id: 1,
            playtime_limit_ms: 0,
            playtime_window_ms: 0,
            suspended: false,
            approval_required: false,
            hub,
        }
    }

    /// Load the tenant's saved world from the db and apply it onto the procedural base. Runs once at
    /// room startup, before any command is processed, so the first joiner sees the restored world.
    async fn restore_world(&mut self) {
        let blob = match self.hub.db.load_world(&self.key.0).await {
            Ok(Some(blob)) => blob,
            Ok(None) => return,
            Err(e) => {
                tracing::error!(tenant = %self.key.0, error = %e, "failed to load world");
                return;
            }
        };
        match sim::decode_edits(&blob) {
            Ok(items) => {
                self.world.load_edits(&items);
                tracing::info!(tenant = %self.key.0, edits = items.len(), "world restored");
            }
            Err(e) => {
                tracing::error!(tenant = %self.key.0, error = %e, "failed to decode world blob")
            }
        }
    }

    pub async fn run(mut self) {
        self.restore_world().await;
        let dt = 1.0 / self.tick_hz as f32;
        let mut interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / self.tick_hz as f64));
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !self.tick(dt) {
                        break;
                    }
                }
                cmd = self.rx.recv() => {
                    match cmd {
                        Some(c) => self.handle(c).await,
                        None => break,
                    }
                }
            }
        }
        // Final save (awaited) so nothing is lost when the room closes.
        if self.dirty {
            let blob = sim::encode_edits(&self.world.snapshot());
            if let Err(e) = self.hub.db.save_world(&self.key.0, &blob).await {
                tracing::error!(tenant = %self.key.0, error = %e, "final world save failed");
            }
        }
        self.hub.remove_room(&self.key);
        tracing::info!(tenant = %self.key.0, world = %self.key.1, "room closed");
    }

    async fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join {
                name,
                claim,
                look,
                ip,
                conn,
                reply,
            } => self.on_join(name, claim, look, ip, conn, reply).await,
            RoomCmd::Input { id, msg } => self.on_input(id, msg),
            RoomCmd::Leave { id } => {
                if self.players.remove(&id).is_some() {
                    self.broadcast(&ServerMsg::Left { id });
                }
            }
            RoomCmd::Rename {
                account_id,
                new_name,
                old_name,
            } => self.on_rename(&account_id, &new_name, &old_name),
            RoomCmd::Announce(msg) => self.broadcast(&msg),
        }
    }

    async fn on_join(
        &mut self,
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        if self.hub.bans.is_banned(ip) {
            let _ = reply.send(Err("banned".into()));
            return;
        }
        if self.players.len() >= self.max_players {
            let _ = reply.send(Err("room_full".into()));
            return;
        }
        // Identity: an empty name+claim is an anonymous guest (the server names them). Otherwise the
        // claim TOKEN must resolve to an account in this tenant; the server adopts that account's
        // CURRENT name (authoritative), ignoring the name the client typed.
        let chosen = name.trim().to_string();
        let guest = chosen.is_empty() && claim.is_empty();
        if guest {
            return self
                .admit(
                    String::new(),
                    String::new(),
                    Role::Player,
                    claim,
                    look,
                    ip,
                    conn,
                    reply,
                )
                .await;
        }
        let resolved = match self.hub.db.claim_to_account(&self.key.0, &claim).await {
            Ok(found) => found,
            Err(e) => {
                tracing::error!(tenant = %self.key.0, error = %e, "claim lookup failed");
                let _ = reply.send(Err("claim_required".into()));
                return;
            }
        };
        let Some((account_id, authoritative_name)) = resolved else {
            tracing::debug!(tenant = %self.key.0, "join rejected: claim required");
            let _ = reply.send(Err("claim_required".into()));
            return;
        };
        let live = self.hub.claims.get(&account_id).as_deref() == Some(claim.as_str());
        if !live {
            tracing::debug!(tenant = %self.key.0, "join rejected: claim required");
            let _ = reply.send(Err("claim_required".into()));
            return;
        }
        let role = self.hub.db.role(&account_id).await.unwrap_or_else(|e| {
            tracing::error!(tenant = %self.key.0, error = %e, "role lookup failed");
            Role::Player
        });
        self.admit(
            account_id,
            authoritative_name,
            role,
            claim,
            look,
            ip,
            conn,
            reply,
        )
        .await;
    }

    /// Build the player, send Welcome + the world EditBatch + the recent timeline backlog (to this
    /// connection only), and register them in the room.
    #[allow(clippy::too_many_arguments)]
    async fn admit(
        &mut self,
        account_id: String,
        authoritative_name: String,
        role: Role,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        // Refresh the per-tenant moderation flags from the db (this room is the single writer, so the
        // cache stays authoritative between joins).
        let (suspended, approval_required) = self
            .hub
            .db
            .tenant_flags(&self.key.0)
            .await
            .unwrap_or((false, false));
        self.suspended = suspended;
        self.approval_required = approval_required;
        // A suspended world turns everyone away except admins, who still need to get in to resume it.
        if self.suspended && !role.is_admin() {
            let _ = conn.try_send(ServerMsg::Error {
                code: "suspended".into(),
                msg: "This world is paused by an admin.".into(),
            });
            let _ = reply.send(Err("suspended".into()));
            return;
        }
        // Approval gate (per-tenant, off by default): while on, admins always get in (to manage),
        // but a guest must log in first and a logged-in player must be approved. A held-out player is
        // recorded as pending and the admins are notified; they approve in-game (and by email).
        if self.approval_required && !role.is_admin() {
            if account_id.is_empty() {
                let _ = conn.try_send(ServerMsg::Error {
                    code: "needs_login".into(),
                    msg: "Please log in so a grown-up can let you in.".into(),
                });
                let _ = reply.send(Err("needs_login".into()));
                return;
            }
            if !self
                .hub
                .db
                .is_approved(&self.key.0, &account_id)
                .await
                .unwrap_or(false)
            {
                self.hold_for_approval(&account_id, &authoritative_name)
                    .await;
                let _ = conn.try_send(ServerMsg::Error {
                    code: "needs_approval".into(),
                    msg: "Waiting for a grown-up to let you in.".into(),
                });
                let _ = reply.send(Err("needs_approval".into()));
                return;
            }
        }
        // Play-time budget (per-tenant, logged-in accounts only): cache the tenant's config and turn an
        // over-budget player away with "time_up".
        let (limit_min, window_h) = self
            .hub
            .db
            .tenant_playtime(&self.key.0)
            .await
            .unwrap_or((0, 0));
        self.playtime_limit_ms = limit_min * 60_000;
        self.playtime_window_ms = window_h * 3_600_000;
        let mut playtime_baseline = 0;
        if self.playtime_limit_ms > 0 && !account_id.is_empty() {
            playtime_baseline = self
                .hub
                .db
                .playtime_used(
                    &self.key.0,
                    &account_id,
                    self.playtime_window_ms,
                    epoch_ms() as i64,
                )
                .await
                .unwrap_or(0);
            if playtime_baseline >= self.playtime_limit_ms {
                let _ = conn.try_send(ServerMsg::Error {
                    code: "time_up".into(),
                    msg: "You've used your play time for now.".into(),
                });
                let _ = reply.send(Err("time_up".into()));
                return;
            }
        }
        let id = self.hub.alloc_id();
        // A guest arrives without a name; give them a unique, recognizable one so two guests never
        // collide on a generic label. A logged-in player keeps their authoritative account name.
        let name = if authoritative_name.is_empty() {
            format!("Guest{id}")
        } else {
            authoritative_name
        };
        let spawn = World::spawn();
        let limits = &self.hub.limits;
        let now = Instant::now();
        let player = Player {
            id,
            name,
            account_id,
            is_admin: role.is_admin(),
            is_moderator: role.is_moderator(),
            claim,
            skin: sanitize_color(&look.skin, "#f2c18b"),
            shirt: sanitize_color(&look.shirt, "#ff5d2e"),
            hair: sanitize_color(&look.hair, "#3a2a1a"),
            ip,
            x: spawn[0],
            y: spawn[1],
            z: spawn[2],
            yaw: 0.0,
            pitch: 0.0,
            ping_ms: 0,
            score: 0,
            conn: conn.clone(),
            last_seen: now,
            last_move: now,
            move_synced: false,
            hp: MAX_HP,
            hurt_at: now,
            dig_block: None,
            dig_hits: 0,
            playtime_baseline_ms: playtime_baseline,
            playtime_persisted_ms: 0,
            inventory: HashMap::new(),
            // Infinite by default to match the old client (admins build freely; an admin turns it off
            // for a player to make them spend banked blocks).
            infinite: true,
            joined_at_ms: epoch_ms(),
            ping_nonce: 0,
            ping_sent_at: now,
            move_b: Bucket::new(limits.move_per_sec),
            edit_b: Bucket::new(limits.edit_per_sec),
            chat_b: Bucket::new(limits.chat_per_sec),
        };
        let welcome = ServerMsg::Welcome {
            you: id,
            tenant: self.key.0.clone(),
            world: self.key.1.clone(),
            brand: self.brand.clone(),
            tick_hz: self.tick_hz,
            spawn,
            admin: role.is_admin(),
            moderator: role.is_moderator(),
            version: server_version(),
        };
        let _ = conn.try_send(welcome);
        // Hand the joining player the world that has already been built.
        let edits: Vec<EditCell> = self
            .world
            .snapshot()
            .into_iter()
            .map(|(x, y, z, block)| EditCell { x, y, z, id: block })
            .collect();
        for chunk in edits.chunks(BATCH_CHUNK_SIZE) {
            let _ = conn.try_send(ServerMsg::EditBatch {
                edits: chunk.to_vec(),
                by: 0,
            });
        }
        // Replay the recent timeline so the history echoes even for events that happened while
        // nobody was online. Sent to this connection only, after Welcome + the world.
        match self
            .hub
            .db
            .recent_events(&self.key.0, crate::db::default_event_backlog())
            .await
        {
            Ok(events) => {
                for event in events {
                    let _ = conn.try_send(ServerMsg::Event {
                        kind: event.kind,
                        name: event.name,
                        detail: event.detail,
                    });
                }
            }
            Err(e) => {
                tracing::error!(tenant = %self.key.0, error = %e, "event backlog load failed")
            }
        }
        // Hand the joining connection the current room-wide settings, after Welcome + world + backlog.
        let _ = conn.try_send(self.room_state());
        // An admin also gets the current pending-approval list so they can manage it right away.
        if role.is_admin() {
            send_pending(&self.hub.db, &self.key.0, std::slice::from_ref(&conn)).await;
        }
        self.players.insert(id, player);
        // The fresh player's inventory (empty + infinite by default), sent after it is registered.
        self.send_inventory(id);
        // Everyone gets the refreshed identity roster so the new player's avatar can render at once
        // (the per-tick Snapshot is slim and carries no names/colors).
        let roster = self.roster_msg();
        self.broadcast(&roster);
        self.empty_since = None;
        let _ = reply.send(Ok(id));
        tracing::info!(tenant = %self.key.0, world = %self.key.1, %id, "player joined");
    }

    /// Apply a server-authoritative rename to the matching live player (matched by account_id, so a
    /// guest is never affected) and broadcast the timeline event to everyone in the room.
    fn on_rename(&mut self, account_id: &str, new_name: &str, old_name: &str) {
        for player in self.players.values_mut() {
            if !player.account_id.is_empty() && player.account_id == account_id {
                player.name = new_name.to_string();
            }
        }
        self.broadcast(&ServerMsg::Event {
            kind: "rename".into(),
            name: new_name.to_string(),
            detail: old_name.to_string(),
        });
        tracing::info!(tenant = %self.key.0, %new_name, %old_name, "player renamed");
    }

    fn on_input(&mut self, id: PlayerId, msg: ClientMsg) {
        let reach = self.hub.limits.edit_reach;
        let max_speed = self.hub.limits.max_speed;
        let now = Instant::now();

        // Admin-only room settings mutate `self` directly, so they're handled before the per-player
        // borrow below. Never trust the client: ignore unless the sender is a known room admin.
        if let ClientMsg::AdminSetPeace { .. }
        | ClientMsg::AdminSetStructure { .. }
        | ClientMsg::AdminSetPvp { .. }
        | ClientMsg::AdminSetChat { .. } = msg
        {
            self.on_admin_setting(id, msg);
            return;
        }

        // Toggling infinite resources is admin-only and sends the player their refreshed inventory.
        if let ClientMsg::AdminSetInfinite { on } = msg {
            self.on_admin_set_infinite(id, on);
            return;
        }

        // Admin kick/ban remove another player, so they touch the whole player map and are handled
        // before the single-player borrow below.
        if let ClientMsg::AdminKick { id: target } | ClientMsg::AdminBan { id: target } = msg {
            self.on_admin_remove(id, target, matches!(msg, ClientMsg::AdminBan { .. }));
            return;
        }

        // Resetting the world wipes shared state (edits + creatures), so it is handled before the
        // single-player borrow below.
        if let ClientMsg::AdminResetScores = msg {
            self.on_admin_reset_scores(id);
            return;
        }
        if let ClientMsg::AdminSuspend { on } = msg {
            self.on_admin_suspend(id, on);
            return;
        }
        if let ClientMsg::AdminResetWorld = msg {
            self.on_admin_reset_world(id);
            return;
        }

        // Role changes touch another account + the whole player map, so handle before the borrow.
        if let ClientMsg::AdminSetRole { id: target, role } = msg {
            self.on_admin_set_role(id, target, role);
            return;
        }

        // Approval toggle + approve touch shared/per-account state and async db, so they own the handler.
        if let ClientMsg::AdminSetApproval { on } = msg {
            self.on_admin_set_approval(id, on);
            return;
        }
        if let ClientMsg::AdminApprove { account_id } = msg {
            self.on_admin_approve(id, account_id);
            return;
        }

        // A PvP attack reads both the attacker and the target, so it is handled before the single
        // borrow below as well.
        if let ClientMsg::AttackPlayer { id: target } = msg {
            if let Some(p) = self.players.get_mut(&id) {
                p.last_seen = now;
            }
            self.on_attack_player(id, target);
            return;
        }

        // A Hit touches both the creature population and the attacker's score, so it is handled before
        // the single-player borrow below (which would conflict).
        if let ClientMsg::Hit { id: creature_id } = msg {
            if let Some(p) = self.players.get_mut(&id) {
                p.last_seen = now;
            }
            self.on_hit(id, creature_id);
            return;
        }
        if let ClientMsg::Respawn = msg {
            if let Some(p) = self.players.get_mut(&id) {
                p.last_seen = now;
            }
            self.respawn(id);
            return;
        }
        // A dig tap touches the player's dig counter and (on the final tap) the shared world, so it is
        // handled before the single-player borrow below.
        if let ClientMsg::Dig { x, y, z } = msg {
            if let Some(p) = self.players.get_mut(&id) {
                p.last_seen = now;
            }
            self.on_dig(id, x, y, z);
            return;
        }

        // Edits and chat need a broadcast after the borrow ends, so stage them.
        let mut edit_out: Option<ServerMsg> = None;
        let mut chat_out: Option<ServerMsg> = None;
        let mut batch_out: Option<ServerMsg> = None;
        // An accepted edit changes the owner's inventory (banked on a break, spent on a place); send it
        // their updated counts after the borrow ends.
        let mut inventory_changed = false;

        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.last_seen = now;

        match msg {
            ClientMsg::Move {
                x,
                y,
                z,
                yaw,
                pitch,
            } => {
                if !p.move_b.take() {
                    return;
                }
                let dt = (now - p.last_move).as_secs_f32().clamp(0.001, 0.5);
                p.last_move = now;
                let (dx, dy, dz) = (x - p.x, y - p.y, z - p.z);
                let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                let allowed = max_speed * dt + 2.0;
                let horizontal = 0.0..=sim::WORLD_SIZE as f32;
                let in_world = horizontal.contains(&x)
                    && horizontal.contains(&z)
                    && (0.0..=sim::MAX_FLY_Y as f32).contains(&y);
                let finite = x.is_finite() && y.is_finite() && z.is_finite();
                let first_sync = !p.move_synced && in_world && finite;
                if in_world && finite && (dist <= allowed || first_sync) {
                    p.move_synced = true;
                    p.x = x;
                    p.y = y;
                    p.z = z;
                    p.yaw = yaw;
                    p.pitch = pitch;
                } else {
                    tracing::debug!(id = %id, dist, allowed, "move rejected by anti-cheat");
                }
                // Out-of-bounds / too-fast moves are dropped: the next snapshot carries
                // the authoritative position and the client reconciles.
            }
            ClientMsg::Edit {
                op,
                x,
                y,
                z,
                id: block,
            } => {
                if !p.edit_b.take() {
                    return;
                }
                if !(0..sim::SIZE_Y).contains(&y) {
                    return;
                }
                let cx = x as f32 + 0.5;
                let cy = y as f32 + 0.5;
                let cz = z as f32 + 0.5;
                let d = ((cx - p.x).powi(2) + (cy - p.y).powi(2) + (cz - p.z).powi(2)).sqrt();
                if d > reach {
                    return;
                }
                let new_id = match op {
                    EditOp::Break => {
                        let removed = self.world.get(x, y, z);
                        if removed != sim::AIR {
                            bank_block(&mut p.inventory, removed);
                            inventory_changed = true;
                        }
                        sim::AIR
                    }
                    EditOp::Place => {
                        if block == 0 || block > sim::MAX_BLOCK {
                            return;
                        }
                        // A non-infinite player must own the block; spending it is the only way the
                        // place is accepted (else the edit is rejected and never broadcast).
                        if !p.infinite && !spend_block(&mut p.inventory, block) {
                            return;
                        }
                        if !p.infinite {
                            inventory_changed = true;
                        }
                        block
                    }
                };
                edit_out = Some(ServerMsg::Edit {
                    x,
                    y,
                    z,
                    id: new_id,
                    by: id,
                });
            }
            ClientMsg::Chat { text } => {
                if !self.chat_enabled {
                    return;
                }
                if !p.chat_b.take() {
                    return;
                }
                let text = text.chars().take(160).collect::<String>();
                if text.trim().is_empty() {
                    return;
                }
                chat_out = Some(ServerMsg::Chat {
                    from: id,
                    name: p.name.clone(),
                    text,
                });
            }
            ClientMsg::EditBatch { edits } => {
                if !p.edit_b.take() || edits.len() > MAX_BATCH_EDITS {
                    return;
                }
                let applied: Vec<EditCell> = edits
                    .into_iter()
                    .filter(|c| (0..sim::SIZE_Y).contains(&c.y) && c.id <= sim::MAX_BLOCK)
                    .filter(|c| {
                        (c.x as f32 + 0.5 - p.x).abs() <= BATCH_RADIUS
                            && (c.z as f32 + 0.5 - p.z).abs() <= BATCH_RADIUS
                    })
                    .collect();
                if !applied.is_empty() {
                    batch_out = Some(ServerMsg::EditBatch {
                        edits: applied,
                        by: id,
                    });
                }
            }
            ClientMsg::Pong { nonce } => {
                if nonce == p.ping_nonce {
                    p.ping_ms = (now - p.ping_sent_at).as_millis().min(u32::MAX as u128) as u32;
                }
            }
            ClientMsg::AdminSetPeace { .. }
            | ClientMsg::AdminSetStructure { .. }
            | ClientMsg::AdminSetPvp { .. }
            | ClientMsg::AdminSetChat { .. }
            | ClientMsg::AdminSetInfinite { .. }
            | ClientMsg::AdminKick { .. }
            | ClientMsg::AdminBan { .. }
            | ClientMsg::AdminResetWorld
            | ClientMsg::AdminResetScores
            | ClientMsg::AdminSuspend { .. }
            | ClientMsg::AdminSetRole { .. }
            | ClientMsg::AdminSetApproval { .. }
            | ClientMsg::AdminApprove { .. }
            | ClientMsg::AttackPlayer { .. }
            | ClientMsg::Hit { .. }
            | ClientMsg::Respawn
            | ClientMsg::Dig { .. } => { /* handled before the per-player borrow above */ }
            ClientMsg::Join { .. } => { /* already joined; ignore */ }
        }

        if let Some(ServerMsg::Edit {
            x, y, z, id: nid, ..
        }) = edit_out.as_ref()
        {
            self.world.set(*x, *y, *z, *nid);
            self.dirty = true;
            tracing::debug!(x = *x, y = *y, z = *z, id = *nid, by = %id, "edit applied");
        }
        if let Some(m) = edit_out {
            self.broadcast(&m);
        }
        if let Some(ServerMsg::EditBatch { edits, .. }) = batch_out.as_ref() {
            for c in edits {
                self.world.set(c.x, c.y, c.z, c.id);
            }
            self.dirty = true;
            tracing::debug!(count = edits.len(), by = %id, "edit batch applied");
        }
        if let Some(m) = batch_out {
            self.broadcast(&m);
        }
        if let Some(m) = chat_out {
            self.broadcast(&m);
        }
        if inventory_changed {
            self.send_inventory(id);
        }
    }

    /// Send a player their authoritative inventory (counts per block id + the infinite flag) to its own
    /// connection. Used on join, on an edit that banks/spends, and when the infinite flag is toggled.
    fn send_inventory(&self, id: PlayerId) {
        let Some(p) = self.players.get(&id) else {
            return;
        };
        let items = p
            .inventory
            .iter()
            .map(|(&block, &count)| InventoryItem { id: block, count })
            .collect();
        let _ = p.conn.try_send(ServerMsg::Inventory {
            items,
            infinite: p.infinite,
        });
    }

    /// Admin-gated toggle of a player's infinite-resources mode (build without spending). Never trust
    /// the client: ignore unless the sender is a known room admin. Sends the refreshed inventory.
    fn on_admin_set_infinite(&mut self, id: PlayerId, on: bool) {
        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.last_seen = Instant::now();
        if !p.is_admin {
            tracing::debug!(%id, "infinite toggle ignored: not an admin");
            return;
        }
        p.infinite = on;
        self.send_inventory(id);
        tracing::debug!(%id, on, "infinite resources toggled");
    }

    /// Apply an admin-gated room setting. The sender must be a known room admin (never trust the
    /// client); on an actual change, broadcast the new RoomState to everyone.
    fn on_admin_setting(&mut self, id: PlayerId, msg: ClientMsg) {
        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.last_seen = Instant::now();
        let is_admin = p.is_admin;
        let is_moderator = p.is_moderator;
        let actor = p.name.clone();
        // Moderators (kids) may flip the harmless toggles; only admins (parents) may toggle chat.
        if !is_admin && !is_moderator {
            tracing::debug!(%id, "room setting ignored: not a moderator/admin");
            return;
        }
        if matches!(msg, ClientMsg::AdminSetChat { .. }) && !is_admin {
            tracing::debug!(%id, "chat toggle ignored: moderators cannot toggle chat");
            return;
        }
        let (changed, action): (bool, &str) = match msg {
            ClientMsg::AdminSetPeace { on } => {
                let changed = self.peace != on;
                self.peace = on;
                (changed, if on { "peace_on" } else { "peace_off" })
            }
            ClientMsg::AdminSetStructure { kind, allowed } => {
                let Some(kind) = valid_structure_kind(&kind) else {
                    return;
                };
                let changed = if allowed {
                    self.blocked_structures.remove(&kind)
                } else {
                    self.blocked_structures.insert(kind)
                };
                (
                    changed,
                    if allowed {
                        "structure_allowed"
                    } else {
                        "structure_blocked"
                    },
                )
            }
            ClientMsg::AdminSetPvp { on } => {
                let changed = self.pvp != on;
                self.pvp = on;
                (changed, if on { "pvp_on" } else { "pvp_off" })
            }
            ClientMsg::AdminSetChat { on } => {
                let changed = self.chat_enabled != on;
                self.chat_enabled = on;
                (changed, if on { "chat_on" } else { "chat_off" })
            }
            _ => (false, ""),
        };
        if changed {
            let state = self.room_state();
            self.broadcast(&state);
            // Surface every admin/moderator action in the feed for everyone.
            self.broadcast(&ServerMsg::Event {
                kind: "admin".into(),
                name: actor,
                detail: action.to_string(),
            });
            tracing::info!(tenant = %self.key.0, peace = self.peace, pvp = self.pvp, chat = self.chat_enabled, blocked = self.blocked_structures.len(), "room settings changed");
        }
    }

    /// Admin-gated removal of another player: kick disconnects them (they may rejoin); ban also blocks
    /// their address so they cannot return. Never trust the client: ignore unless the sender is an
    /// admin. Sends the leaving player an Error so their client knows why, then broadcasts Left.
    fn on_admin_remove(&mut self, admin_id: PlayerId, target_id: PlayerId, ban: bool) {
        let Some(admin) = self.players.get_mut(&admin_id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%admin_id, "admin command ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        let Some(target) = self.players.get(&target_id) else {
            return;
        };
        let target_ip = target.ip;
        let target_name = target.name.clone();
        let (code, message) = if ban {
            ("banned", "Your access has been revoked.")
        } else {
            ("kicked", "You were removed from the room by an admin.")
        };
        let _ = target.conn.try_send(ServerMsg::Error {
            code: code.into(),
            msg: message.into(),
        });
        if ban {
            self.hub.bans.ban(target_ip);
        }
        self.players.remove(&target_id);
        self.broadcast(&ServerMsg::Left { id: target_id });
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("{}|{}", if ban { "ban" } else { "kick" }, target_name),
        });
        tracing::info!(tenant = %self.key.0, %admin_id, %target_id, ban, "player removed by admin");
    }

    /// Admin-gated world wipe: replace the world with a fresh one (clearing every edit), drop all
    /// creatures and reset the id counter, persist the cleared world, and broadcast a "reset" event so
    /// every client rebuilds the procedural map. Never trust the client: ignore unless an admin sent it.
    fn on_admin_reset_world(&mut self, id: PlayerId) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        // World reset is a harmless toggle (kids can do it), so moderators are allowed too.
        if !admin.is_admin && !admin.is_moderator {
            tracing::debug!(%id, "world reset ignored: not a moderator/admin");
            return;
        }
        let admin_name = admin.name.clone();
        self.world = World::new();
        self.creatures.clear();
        self.next_creature_id = 1;
        self.dirty = true;
        self.flush();
        self.broadcast(&ServerMsg::Event {
            kind: "reset".into(),
            name: admin_name,
            detail: String::new(),
        });
        tracing::info!(tenant = %self.key.0, %id, "world reset by admin");
    }

    /// Wipe everyone's score: reset live players to zero and clear the persisted leaderboard. Admin-only
    /// (it destroys other players' progress), broadcast to the feed.
    fn on_admin_reset_scores(&mut self, id: PlayerId) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "score reset ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        for p in self.players.values_mut() {
            p.score = 0;
        }
        let db = self.hub.db.clone();
        let tenant = self.key.0.clone();
        tokio::spawn(async move {
            if let Err(e) = db.reset_scores(&tenant).await {
                tracing::error!(error = %e, "reset_scores failed");
            }
        });
        self.broadcast(&ServerMsg::Event {
            kind: "reset_scores".into(),
            name: admin_name,
            detail: String::new(),
        });
        tracing::info!(tenant = %self.key.0, %id, "scores reset by admin");
    }

    /// Suspend or resume the world. Admin-only: suspending persists the flag (so it survives a restart),
    /// announces it, and disconnects everyone to the lobby — no one can rejoin until an admin resumes it.
    fn on_admin_suspend(&mut self, id: PlayerId, on: bool) {
        let Some(admin) = self.players.get(&id) else {
            return;
        };
        if !admin.is_admin {
            tracing::debug!(%id, "suspend ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        self.suspended = on;
        self.persist_tenant_flag(TenantFlag::Suspended, on);
        let state = self.room_state();
        self.broadcast(&state);
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: if on {
                "suspend_on".into()
            } else {
                "suspend_off".into()
            },
        });
        if on {
            // Everyone is sent to the lobby except the admin who suspended it, who stays to resume.
            let ids: Vec<PlayerId> = self.players.keys().copied().filter(|&p| p != id).collect();
            for pid in ids {
                if let Some(p) = self.players.remove(&pid) {
                    let _ = p.conn.try_send(ServerMsg::Error {
                        code: "suspended".into(),
                        msg: "This world is paused by an admin.".into(),
                    });
                }
                self.broadcast(&ServerMsg::Left { id: pid });
            }
        }
        tracing::info!(tenant = %self.key.0, %id, on, "world suspension set by admin");
    }

    /// Change an online player's role. Admins (parents) may grant any role; moderators (kids) may only
    /// add or remove other moderators (never touch an admin, never grant admin). The change takes
    /// effect live (the target's flags + a Role message) and is persisted to the account.
    fn on_admin_set_role(
        &mut self,
        actor_id: PlayerId,
        target_id: PlayerId,
        wire_role: protocol::Role,
    ) {
        let role = Role::from(wire_role);
        let Some(actor) = self.players.get_mut(&actor_id) else {
            return;
        };
        actor.last_seen = Instant::now();
        let actor_is_admin = actor.is_admin;
        let actor_is_moderator = actor.is_moderator;
        let actor_name = actor.name.clone();
        let may_grant = actor_is_admin || (actor_is_moderator && role != Role::Admin);
        if !may_grant {
            tracing::debug!(%actor_id, "set-role ignored: insufficient authority");
            return;
        }
        let Some(target) = self.players.get_mut(&target_id) else {
            return;
        };
        if !actor_is_admin && target.is_admin {
            tracing::debug!(%actor_id, "set-role ignored: a moderator cannot change an admin");
            return;
        }
        target.is_admin = role.is_admin();
        target.is_moderator = role.is_moderator();
        let target_account = target.account_id.clone();
        let target_name = target.name.clone();
        let _ = target.conn.try_send(ServerMsg::Role {
            admin: role.is_admin(),
            moderator: role.is_moderator(),
        });
        let role_word = match role {
            Role::Admin => "role_admin",
            Role::Moderator => "role_moderator",
            Role::Player => "role_player",
        };
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: actor_name,
            detail: format!("{role_word}|{target_name}"),
        });
        // Reflect the new badge for everyone immediately rather than waiting for the next roster sweep.
        let roster = self.roster_msg();
        self.broadcast(&roster);
        // A guest's promotion is session-only (no account to persist to); registered players keep it.
        if !target_account.is_empty() {
            let db = self.hub.db.clone();
            tokio::spawn(async move {
                if let Err(e) = db.set_role(&target_account, role).await {
                    tracing::error!(error = %e, "set_role persist failed");
                }
            });
        }
        tracing::info!(tenant = %self.key.0, %actor_id, %target_id, ?role, "role changed in-game");
    }

    /// Record a held-out account as pending, email the tenant's admins, and refresh the in-game
    /// pending list for any online admin so they can approve immediately.
    async fn hold_for_approval(&mut self, account_id: &str, name: &str) {
        let email = match self.hub.db.get_account_by_id(account_id).await {
            Ok(Some(account)) => account.email,
            Ok(None) => {
                tracing::warn!(%account_id, "approval hold skipped: account vanished");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "approval hold: account lookup failed");
                return;
            }
        };
        if let Err(e) = self
            .hub
            .db
            .record_approval_request(&self.key.0, account_id, name, &email)
            .await
        {
            tracing::error!(error = %e, "approval request persist failed");
            return;
        }
        tracing::info!(tenant = %self.key.0, %account_id, "player held for approval");
        let db = self.hub.db.clone();
        let tenant = self.key.0.clone();
        let player_name = name.to_string();
        tokio::spawn(async move {
            crate::notify::approval_request(&db, &tenant, &player_name).await;
        });
        self.broadcast_pending_to_admins().await;
    }

    /// Turn the per-tenant approval gate on or off. Admin-only; persists the flag, broadcasts the new
    /// RoomState, and (when turning it on) hands online admins the current pending list.
    fn on_admin_set_approval(&mut self, id: PlayerId, on: bool) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "approval toggle ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        if self.approval_required == on {
            return;
        }
        self.approval_required = on;
        self.persist_tenant_flag(TenantFlag::ApprovalRequired, on);
        let state = self.room_state();
        self.broadcast(&state);
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: if on {
                "approval_on".into()
            } else {
                "approval_off".into()
            },
        });
        let tenant = self.key.0.clone();
        let admin_conns: Vec<mpsc::Sender<ServerMsg>> = self
            .players
            .values()
            .filter(|p| p.is_admin)
            .map(|p| p.conn.clone())
            .collect();
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            send_pending(&db, &tenant, &admin_conns).await;
        });
        tracing::info!(tenant = %self.key.0, %id, on, "approval gate set by admin");
    }

    /// Approve a pending account. Admin-only; records the approval, tells the waiting player they can
    /// join (so their client retries), and refreshes the pending list for online admins.
    fn on_admin_approve(&mut self, id: PlayerId, account_id: String) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "approve ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("approve|{account_id}"),
        });
        let tenant = self.key.0.clone();
        let admin_conns: Vec<mpsc::Sender<ServerMsg>> = self
            .players
            .values()
            .filter(|p| p.is_admin)
            .map(|p| p.conn.clone())
            .collect();
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

    /// Push the current pending-approval list to every online admin (no-op if none are online).
    async fn broadcast_pending_to_admins(&self) {
        let admin_conns: Vec<mpsc::Sender<ServerMsg>> = self
            .players
            .values()
            .filter(|p| p.is_admin)
            .map(|p| p.conn.clone())
            .collect();
        send_pending(&self.hub.db, &self.key.0, &admin_conns).await;
    }

    /// A PvP melee attack on another player. Ignored unless pvp is on and the attacker is within melee
    /// range of the target; the server never damages server-side (the client owns hearts) and only
    /// tells the target it was hit so it takes one heart of damage.
    fn on_attack_player(&mut self, attacker_id: PlayerId, target_id: PlayerId) {
        if !self.pvp {
            return;
        }
        if attacker_id == target_id {
            return;
        }
        let Some(attacker) = self.players.get(&attacker_id) else {
            return;
        };
        let (attacker_x, attacker_y, attacker_z) = (attacker.x, attacker.y, attacker.z);
        let attacker_name = attacker.name.clone();
        let Some(target) = self.players.get(&target_id) else {
            return;
        };
        let (target_x, target_y, target_z) = (target.x, target.y, target.z);
        let dist = ((target_x - attacker_x).powi(2)
            + (target_y - attacker_y).powi(2)
            + (target_z - attacker_z).powi(2))
        .sqrt();
        if dist > MELEE_RANGE {
            tracing::debug!(%attacker_id, %target_id, dist, "pvp attack rejected: out of range");
            return;
        }
        // Hearts are server-owned: apply the damage, flash the target, and respawn it if it ran out.
        let Some(target) = self.players.get_mut(&target_id) else {
            return;
        };
        target.hp = target.hp.saturating_sub(1);
        target.hurt_at = Instant::now();
        let died = target.hp == 0;
        let _ = target.conn.try_send(ServerMsg::Hurt { by: attacker_name });
        // Everyone but the attacker sees the same hit effect on the target.
        self.broadcast_except(
            attacker_id,
            &ServerMsg::Attack {
                kind: "player".into(),
                id: target_id,
            },
        );
        if died {
            self.respawn(target_id);
        }
        tracing::debug!(tenant = %self.key.0, %attacker_id, %target_id, "pvp hit");
    }

    /// Write a per-tenant moderation flag through to the `tenants` row off the hot path; the caller has
    /// already updated the in-memory cache.
    fn persist_tenant_flag(&self, flag: TenantFlag, on: bool) {
        let db = self.hub.db.clone();
        let tenant = self.key.0.clone();
        tokio::spawn(async move {
            let result = match flag {
                TenantFlag::Suspended => db.set_tenant_suspended(&tenant, on).await,
                TenantFlag::ApprovalRequired => db.set_tenant_approval_required(&tenant, on).await,
            };
            if let Err(e) = result {
                tracing::error!(error = %e, "failed to persist tenant flag");
            }
        });
    }

    /// The static identity of every online player, so the per-tick Snapshot can stay slim. Broadcast on
    /// join and on the periodic sweep (not every tick).
    fn roster_msg(&self) -> ServerMsg {
        ServerMsg::Roster {
            players: self
                .players
                .values()
                .map(|p| PlayerMeta {
                    id: p.id,
                    name: p.name.clone(),
                    skin: p.skin.clone(),
                    shirt: p.shirt.clone(),
                    hair: p.hair.clone(),
                    admin: p.is_admin,
                    moderator: p.is_moderator,
                })
                .collect(),
        }
    }

    /// Snapshot the room-wide settings as the wire message broadcast on change and sent on join.
    fn room_state(&self) -> ServerMsg {
        ServerMsg::RoomState {
            peace: self.peace,
            blocked_structures: self.blocked_structures.iter().cloned().collect(),
            pvp: self.pvp,
            chat_enabled: self.chat_enabled,
            suspended: self.suspended,
            approval_required: self.approval_required,
        }
    }

    fn tick(&mut self, dt: f32) -> bool {
        self.tick += 1;

        // Rate buckets must refill every tick so limits stay smooth.
        for p in self.players.values_mut() {
            p.move_b.refill(dt);
            p.edit_b.refill(dt);
            p.chat_b.refill(dt);
        }

        // The ban/reclaim/idle sweep (DashMap lookups per player) runs at ~2Hz, not every tick.
        let now = Instant::now();
        if self.tick.is_multiple_of(STATUS_EVERY_TICKS) {
            let idle = Duration::from_secs(self.hub.limits.idle_secs);
            let mut kicked: Vec<PlayerId> = Vec::new();
            for p in self.players.values() {
                if self.hub.bans.is_banned(p.ip) {
                    let _ = p.conn.try_send(ServerMsg::Error {
                        code: "banned".into(),
                        msg: "Your access has been revoked.".into(),
                    });
                    tracing::debug!(id = %p.id, ip = %p.ip, "banned kick");
                    kicked.push(p.id);
                    continue;
                }
                // Kick-on-reclaim: a logged-in player whose claim is no longer the live one (someone
                // re-claimed the account) is dropped. Guests (no account_id) are never affected.
                let still_holds =
                    self.hub.claims.get(&p.account_id).as_deref() == Some(p.claim.as_str());
                if !p.account_id.is_empty() && !still_holds {
                    let _ = p.conn.try_send(ServerMsg::Error {
                        code: "reclaimed".into(),
                        msg: "Your username was taken over from another device.".into(),
                    });
                    tracing::debug!(id = %p.id, account_id = %p.account_id, "reclaimed kick");
                    kicked.push(p.id);
                    continue;
                }
                if now.duration_since(p.last_seen) > idle {
                    let _ = p.conn.try_send(ServerMsg::Error {
                        code: "idle_timeout".into(),
                        msg: "You were idle for too long.".into(),
                    });
                    tracing::debug!(id = %p.id, "idle kick");
                    kicked.push(p.id);
                }
            }
            for id in kicked {
                self.players.remove(&id);
                self.broadcast(&ServerMsg::Left { id });
            }

            // Play-time accounting: flush each logged-in player's session delta to the db and send the
            // ones who hit their budget to the lobby.
            if self.playtime_limit_ms > 0 {
                let limit = self.playtime_limit_ms;
                let window = self.playtime_window_ms;
                let now_ms = epoch_ms() as i64;
                let tenant = self.key.0.clone();
                let mut time_up: Vec<PlayerId> = Vec::new();
                for p in self.players.values_mut() {
                    if p.account_id.is_empty() {
                        continue;
                    }
                    let session = now_ms - p.joined_at_ms as i64;
                    let delta = session - p.playtime_persisted_ms;
                    if delta > 0 {
                        p.playtime_persisted_ms = session;
                        let db = self.hub.db.clone();
                        let tenant = tenant.clone();
                        let account = p.account_id.clone();
                        tokio::spawn(async move {
                            if let Err(e) = db
                                .add_playtime(&tenant, &account, delta, window, now_ms)
                                .await
                            {
                                tracing::error!(error = %e, "add_playtime failed");
                            }
                        });
                    }
                    if p.playtime_baseline_ms + session >= limit {
                        time_up.push(p.id);
                    }
                }
                for id in time_up {
                    if let Some(p) = self.players.remove(&id) {
                        let _ = p.conn.try_send(ServerMsg::Error {
                            code: "time_up".into(),
                            msg: "You've used your play time for now.".into(),
                        });
                    }
                    self.broadcast(&ServerMsg::Left { id });
                }
            }
        }

        // Server-initiated ping for authoritative latency measurement.
        if self.tick.is_multiple_of(PING_EVERY_TICKS) {
            for p in self.players.values_mut() {
                p.ping_nonce = p.ping_nonce.wrapping_add(1);
                p.ping_sent_at = now;
                let _ = p.conn.try_send(ServerMsg::Ping {
                    nonce: p.ping_nonce,
                });
            }
        }

        // Maintain and advance the creature population before snapshotting it.
        self.simulate_creatures(dt);

        // Broadcast the world snapshot. Each state is a fixed-order number array (see protocol) so the
        // hot per-tick payload carries no field names; coordinates are rounded to keep the digits small.
        let states: Vec<PlayerState> = self
            .players
            .values()
            .map(|p| {
                PlayerState(
                    p.id,
                    round_snapshot(p.x),
                    round_snapshot(p.y),
                    round_snapshot(p.z),
                    round_snapshot(p.yaw),
                    round_snapshot(p.pitch),
                    p.ping_ms,
                    p.score,
                    p.hp,
                )
            })
            .collect();
        let creatures: Vec<CreatureState> = self
            .creatures
            .iter()
            .map(|c| {
                CreatureState(
                    c.id,
                    c.kind.index(),
                    round_snapshot(c.pos[0]),
                    round_snapshot(c.pos[1]),
                    round_snapshot(c.pos[2]),
                    round_snapshot(c.yaw),
                    c.hp,
                    c.max_hp,
                )
            })
            .collect();
        let snap = ServerMsg::Snapshot {
            tick: self.tick,
            players: states,
            creatures,
        };
        self.broadcast(&snap);

        if self.tick.is_multiple_of(STATUS_EVERY_TICKS) {
            self.publish_stats(now);
            // Refresh the identity roster so late joiners + renames reach everyone within the sweep
            // cadence; the per-tick Snapshot stays slim.
            if !self.players.is_empty() {
                let roster = self.roster_msg();
                self.broadcast(&roster);
            }
        }

        // Persist the world diff at most every PERSIST_SECS, and only when it changed.
        if self.tick.is_multiple_of(PERSIST_SECS * self.tick_hz as u64) {
            self.flush();
        }

        // Garbage-collect an empty room after a grace period.
        if self.players.is_empty() {
            let since = *self.empty_since.get_or_insert(now);
            if now.duration_since(since) > EMPTY_ROOM_TTL {
                return false;
            }
        } else {
            self.empty_since = None;
        }
        true
    }

    fn broadcast(&self, msg: &ServerMsg) {
        for p in self.players.values() {
            let _ = p.conn.try_send(msg.clone());
        }
    }

    /// Broadcast to everyone except one player (e.g. the attacker, who already played the hit effect
    /// locally for instant feedback — the others see it via this).
    fn broadcast_except(&self, except: PlayerId, msg: &ServerMsg) {
        for p in self.players.values() {
            if p.id == except {
                continue;
            }
            let _ = p.conn.try_send(msg.clone());
        }
    }

    /// Keep a capped creature population near active players and advance each one. Despawn creatures
    /// no player is close to; spawn up to the cap around a random player on a slow cadence.
    fn simulate_creatures(&mut self, dt: f32) {
        let player_xz: Vec<[f32; 2]> = self.players.values().map(|p| [p.x, p.z]).collect();
        if player_xz.is_empty() {
            self.creatures.clear();
            return;
        }
        self.creatures
            .retain(|c| nearest_horizontal(c.pos, &player_xz) <= DESPAWN_RADIUS);
        // Maintain a per-player target population so a crowded area keeps more creatures, refilling the
        // deficit a few at a time so kills are replaced quickly without a spawn burst.
        let target = (player_xz.len() * CREATURES_PER_PLAYER).clamp(MIN_CREATURES, MAX_CREATURES);
        if self.tick.is_multiple_of(SPAWN_EVERY_TICKS) {
            let deficit = target.saturating_sub(self.creatures.len());
            for _ in 0..deficit.min(SPAWN_BATCH) {
                self.spawn_near(&player_xz);
            }
        }
        let peace = self.peace;
        let tick = self.tick;
        let world = &self.world;
        for creature in self.creatures.iter_mut() {
            creature.advance(&player_xz, peace, dt, tick, |x, z| world.surface_y(x, z));
        }
        if peace {
            return;
        }
        // A hostile creature out in the open (not buried) at the player's level bites for one heart, on
        // the same cooldown the web used. Health is the server's now; the client only renders it.
        let biters: Vec<[f32; 3]> = self
            .creatures
            .iter()
            .filter(|c| c.kind.config().hostile)
            .filter(|c| {
                !world.is_solid(
                    c.pos[0].floor() as i32,
                    c.pos[1].floor() as i32 + 1,
                    c.pos[2].floor() as i32,
                )
            })
            .map(|c| c.pos)
            .collect();
        let now = Instant::now();
        let mut dead: Vec<PlayerId> = Vec::new();
        for p in self.players.values_mut() {
            if now.duration_since(p.hurt_at) < HURT_COOLDOWN {
                continue;
            }
            let feet = p.y - PLAYER_EYE_HEIGHT;
            let bitten = biters.iter().any(|c| {
                ((p.x - c[0]).powi(2) + (p.z - c[2]).powi(2)).sqrt() < HURT_RANGE
                    && c[1] >= feet - HURT_LEVEL_SLACK
                    && c[1] <= feet + PLAYER_BODY_HEIGHT
            });
            if !bitten {
                continue;
            }
            p.hp = p.hp.saturating_sub(1);
            p.hurt_at = now;
            let _ = p.conn.try_send(ServerMsg::Hurt { by: String::new() });
            if p.hp == 0 {
                dead.push(p.id);
            }
        }
        for id in dead {
            self.respawn(id);
        }
    }

    /// Move a player to spawn with full health and re-baseline the anti-cheat (so the client's snap to
    /// spawn is accepted), telling them to reposition + refill. Used by the respawn request and on death.
    fn respawn(&mut self, id: PlayerId) {
        let spawn = World::spawn();
        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.x = spawn[0];
        p.y = spawn[1];
        p.z = spawn[2];
        p.hp = MAX_HP;
        p.hurt_at = Instant::now();
        p.move_synced = false;
        let _ = p.conn.try_send(ServerMsg::Respawn {
            x: spawn[0],
            y: spawn[1],
            z: spawn[2],
            hp: MAX_HP,
        });
    }

    /// Count a dig tap against a block (resetting when the player switches blocks). After DIG_HITS taps
    /// on the same in-reach solid block the server breaks it and broadcasts the edit to everyone, so the
    /// dig difficulty is authoritative.
    fn on_dig(&mut self, id: PlayerId, x: i32, y: i32, z: i32) {
        let reach = self.hub.limits.edit_reach;
        {
            let Some(p) = self.players.get_mut(&id) else {
                return;
            };
            if !p.edit_b.take() {
                return;
            }
            if !(0..sim::SIZE_Y).contains(&y) {
                return;
            }
            let d = ((x as f32 + 0.5 - p.x).powi(2)
                + (y as f32 + 0.5 - p.y).powi(2)
                + (z as f32 + 0.5 - p.z).powi(2))
            .sqrt();
            if d > reach {
                return;
            }
            let cell = [x, y, z];
            if p.dig_block == Some(cell) {
                p.dig_hits += 1;
            } else {
                p.dig_block = Some(cell);
                p.dig_hits = 1;
            }
            if p.dig_hits < DIG_HITS {
                return;
            }
            p.dig_block = None;
            p.dig_hits = 0;
        }
        if !self.world.is_solid(x, y, z) {
            return;
        }
        let removed = self.world.get(x, y, z);
        self.world.set(x, y, z, sim::AIR);
        self.dirty = true;
        self.broadcast(&ServerMsg::Edit {
            x,
            y,
            z,
            id: sim::AIR,
            by: id,
        });
        // Banking the dug block to the digger's inventory is the authoritative break path (the client
        // sends Dig, not Edit::Break, for in-world digging).
        if removed != sim::AIR {
            if let Some(p) = self.players.get_mut(&id) {
                bank_block(&mut p.inventory, removed);
            }
            self.send_inventory(id);
        }
    }

    /// Spawn one creature near a player, kind and offset derived from the creature id and tick so the
    /// population varies without any RNG state.
    fn spawn_near(&mut self, player_xz: &[[f32; 2]]) {
        let id = self.next_creature_id;
        self.next_creature_id = self.next_creature_id.wrapping_add(1);
        let anchor = player_xz[id as usize % player_xz.len()];
        let angle = id as f32 * 2.399_963;
        let radius = SPAWN_RADIUS * (0.4 + ((id as f32 * 0.37).sin() * 0.5 + 0.5) * 0.6);
        let x = anchor[0] + angle.cos() * radius;
        let z = anchor[1] + angle.sin() * radius;
        let kind = CreatureKind::ALL[id as usize % CreatureKind::ALL.len()];
        let world = &self.world;
        let creature = Creature::spawn(id, kind, x, z, |cx, cz| world.surface_y(cx, cz));
        self.creatures.push(creature);
        tracing::debug!(tenant = %self.key.0, id, kind = kind.slug(), "creature spawned");
    }

    /// Validate and apply a melee Hit: the attacker must be within range of a live creature. On a kill,
    /// award the kind reward, broadcast a live "kill" event, and persist the new total for an account.
    fn on_hit(&mut self, attacker_id: PlayerId, creature_id: u32) {
        let Some(attacker) = self.players.get(&attacker_id) else {
            return;
        };
        let (attacker_x, attacker_z) = (attacker.x, attacker.z);
        let Some(index) = self.creatures.iter().position(|c| c.id == creature_id) else {
            return;
        };
        let creature = &self.creatures[index];
        let dist = ((creature.pos[0] - attacker_x).powi(2)
            + (creature.pos[2] - attacker_z).powi(2))
        .sqrt();
        if dist > MELEE_RANGE {
            tracing::debug!(%attacker_id, creature_id, dist, "hit rejected: out of range");
            return;
        }
        let kind = self.creatures[index].kind;
        self.creatures[index].hp = self.creatures[index].hp.saturating_sub(1);
        // Everyone but the attacker sees the same flash on the creature (the attacker plays it locally).
        self.broadcast_except(
            attacker_id,
            &ServerMsg::Attack {
                kind: "creature".into(),
                id: creature_id,
            },
        );
        if self.creatures[index].hp > 0 {
            return;
        }
        self.creatures.remove(index);
        let reward = kind.config().reward;
        let Some(attacker) = self.players.get_mut(&attacker_id) else {
            return;
        };
        attacker.score = attacker.score.saturating_add(reward);
        let name = attacker.name.clone();
        let account_id = attacker.account_id.clone();
        let new_total = attacker.score;
        self.broadcast(&ServerMsg::Event {
            kind: "kill".into(),
            name,
            detail: kind.slug().to_string(),
        });
        tracing::info!(tenant = %self.key.0, %attacker_id, creature = kind.slug(), reward, "creature killed");
        if account_id.is_empty() {
            return;
        }
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.submit_score(&account_id, new_total as i64).await {
                tracing::error!(error = %e, "submit_score after kill failed");
            }
        });
    }

    /// Save the world diff off the tick thread (only when it changed).
    fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let tenant = self.key.0.clone();
        let blob = sim::encode_edits(&self.world.snapshot());
        tracing::debug!(tenant = %tenant, edits = self.world.edit_count(), bytes = blob.len(), "world flush");
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.save_world(&tenant, &blob).await {
                tracing::error!(%tenant, error = %e, "world save failed");
            }
        });
    }

    fn publish_stats(&self, now: Instant) {
        let players = self
            .players
            .values()
            .map(|p| PlayerInfo {
                id: p.id,
                name: p.name.clone(),
                x: p.x,
                y: p.y,
                z: p.z,
                ping_ms: p.ping_ms,
                idle_ms: now.duration_since(p.last_seen).as_millis() as u64,
                joined_at_ms: p.joined_at_ms,
            })
            .collect();
        self.hub.room_stats.insert(
            self.key.clone(),
            RoomSnapshot {
                tenant: self.key.0.clone(),
                world: self.key.1.clone(),
                tick: self.tick,
                edits: self.world.edit_count(),
                players,
            },
        );
    }
}

// Cap on a structure-kind id (the web prebuilt ids are short slugs like "trophy", "steve").
const MAX_STRUCTURE_KIND_LEN: usize = 24;

/// Bank one of a broken block into a player's inventory.
fn bank_block(inventory: &mut HashMap<u8, u32>, block: u8) {
    *inventory.entry(block).or_insert(0) += 1;
}

/// Spend one of a block from a player's inventory; returns false (rejecting the place) when none is held.
fn spend_block(inventory: &mut HashMap<u8, u32>, block: u8) -> bool {
    let Some(count) = inventory.get_mut(&block) else {
        return false;
    };
    if *count == 0 {
        return false;
    }
    *count -= 1;
    true
}

/// Accept a prebuilt structure-kind id: a short, lowercase alphanumeric slug. Anything else is
/// rejected so the blocked set never fills with client junk. Returns the validated kind.
fn valid_structure_kind(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= MAX_STRUCTURE_KIND_LEN
        && trimmed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    ok.then(|| trimmed.to_string())
}

// Accept only a `#rrggbb` hex color; fall back to the given default for anything else (cosmetic).
fn sanitize_color(raw: &str, default: &str) -> String {
    let ok =
        raw.len() == 7 && raw.starts_with('#') && raw[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        raw.to_lowercase()
    } else {
        default.to_string()
    }
}

/// Round a snapshot coordinate to centimeter precision so the wire number stays short.
fn round_snapshot(value: f32) -> f32 {
    (value * SNAPSHOT_DECIMALS).round() / SNAPSHOT_DECIMALS
}

/// Horizontal distance from a creature position to its nearest player; `f32::MAX` when none exist.
fn nearest_horizontal(pos: [f32; 3], players: &[[f32; 2]]) -> f32 {
    players
        .iter()
        .map(|p| ((p[0] - pos[0]).powi(2) + (p[1] - pos[2]).powi(2)).sqrt())
        .fold(f32::MAX, f32::min)
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Load the tenant's pending-approval list and send it to each given (admin) connection.
async fn send_pending(db: &crate::db::Db, tenant: &str, conns: &[mpsc::Sender<ServerMsg>]) {
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
        let _ = conn.try_send(ServerMsg::PendingApprovals {
            pending: wire.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::hub::Hub;
    use std::sync::Arc;

    /// A room wired to a fresh memory-db hub. The command receiver is owned by the room; tests drive
    /// it by calling its handlers directly rather than through the channel.
    async fn test_room() -> Room {
        // Each test gets a fresh in-memory db, so the per-tenant flags (suspended/approval) start off
        // with no cross-test leak — no file-backed-gate reset needed anymore.
        let db = Arc::new(Db::memory().await);
        let hub = Arc::new(Hub::load(db).await);
        let tcfg = hub.tenants.get("teo").unwrap().clone();
        let (_tx, rx) = mpsc::channel::<RoomCmd>(16);
        Room::new(hub, &tcfg, "main".into(), rx)
    }

    /// Insert a minimal player into the room and return the channel that captures messages sent to it.
    fn add_player(room: &mut Room, id: PlayerId, is_admin: bool) -> mpsc::Receiver<ServerMsg> {
        let (conn, conn_rx) = mpsc::channel::<ServerMsg>(64);
        let now = Instant::now();
        let player = Player {
            id,
            name: format!("p{id}"),
            account_id: format!("acc{id}"),
            is_admin,
            is_moderator: false,
            claim: format!("tok{id}"),
            skin: "#000000".into(),
            shirt: "#000000".into(),
            hair: "#000000".into(),
            ip: "127.0.0.1".parse().unwrap(),
            x: 0.0,
            y: 0.0,
            z: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            ping_ms: 0,
            score: 0,
            conn,
            last_seen: now,
            last_move: now,
            move_synced: false,
            hp: MAX_HP,
            hurt_at: now,
            dig_block: None,
            dig_hits: 0,
            playtime_baseline_ms: 0,
            playtime_persisted_ms: 0,
            inventory: HashMap::new(),
            infinite: true,
            joined_at_ms: 0,
            ping_nonce: 0,
            ping_sent_at: now,
            move_b: Bucket::new(100.0),
            edit_b: Bucket::new(100.0),
            chat_b: Bucket::new(100.0),
        };
        room.players.insert(id, player);
        conn_rx
    }

    fn drain_room_state(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<(bool, Vec<String>)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::RoomState {
                peace,
                blocked_structures,
                ..
            } = msg
            {
                latest = Some((peace, blocked_structures));
            }
        }
        latest
    }

    /// The latest broadcast (pvp, chat_enabled) pair, ignoring peace/structure fields.
    fn drain_pvp_chat(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<(bool, bool)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::RoomState {
                pvp, chat_enabled, ..
            } = msg
            {
                latest = Some((pvp, chat_enabled));
            }
        }
        latest
    }

    fn drain_left(rx: &mut mpsc::Receiver<ServerMsg>) -> Vec<PlayerId> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::Left { id } = msg {
                out.push(id);
            }
        }
        out
    }

    fn drain_hurt(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<String> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::Hurt { by } = msg {
                latest = Some(by);
            }
        }
        latest
    }

    #[tokio::test]
    async fn admin_toggles_peace_and_broadcasts_room_state() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let mut other_rx = add_player(&mut room, 2, false);

        room.on_admin_setting(1, ClientMsg::AdminSetPeace { on: false });
        assert!(!room.peace);
        assert_eq!(drain_room_state(&mut admin_rx), Some((false, vec![])));
        assert_eq!(drain_room_state(&mut other_rx), Some((false, vec![])));
    }

    #[tokio::test]
    async fn non_admin_peace_is_ignored() {
        let mut room = test_room().await;
        let mut other_rx = add_player(&mut room, 2, false);

        room.on_admin_setting(2, ClientMsg::AdminSetPeace { on: false });
        assert!(room.peace);
        assert_eq!(drain_room_state(&mut other_rx), None);
    }

    #[tokio::test]
    async fn suspending_the_room_sends_every_non_admin_back_to_the_lobby() {
        let mut room = test_room().await;
        add_player(&mut room, 1, true); // the admin who suspends stays to resume
        let mut player_rx = add_player(&mut room, 2, false);
        add_player(&mut room, 3, false);

        room.on_admin_suspend(1, true);

        assert!(room.suspended);
        assert!(
            room.players.contains_key(&1),
            "the suspending admin keeps playing"
        );
        assert!(
            !room.players.contains_key(&2),
            "ordinary players are ejected"
        );
        assert!(!room.players.contains_key(&3));
        // The ejected player is told why, so the client drops to the lobby instead of reconnecting.
        let suspended = std::iter::from_fn(|| player_rx.try_recv().ok())
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "suspended"));
        assert!(suspended, "ejected player receives the suspended error");
    }

    #[tokio::test]
    async fn first_move_is_accepted_as_baseline_then_speed_checked() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        // The client may spawn or restore far from the server spawn; the first move is taken verbatim so
        // the player isn't frozen by the anti-cheat (which would otherwise reject every later move too).
        room.on_input(
            1,
            ClientMsg::Move {
                x: 50.0,
                y: 20.0,
                z: 50.0,
                yaw: 0.0,
                pitch: 0.0,
            },
        );
        assert_eq!(room.players.get(&1).unwrap().x, 50.0);
        // Once synced, an impossibly fast jump is rejected and the position holds.
        room.on_input(
            1,
            ClientMsg::Move {
                x: 120.0,
                y: 20.0,
                z: 50.0,
                yaw: 0.0,
                pitch: 0.0,
            },
        );
        assert_eq!(room.players.get(&1).unwrap().x, 50.0);
    }

    // Stand a player on the open ground with a hostile creature spawned on the same spot, so after the
    // sim advances it they are at the same level and within bite range.
    fn bite_setup(room: &mut Room) {
        room.peace = false;
        let spider = Creature::spawn(99, CreatureKind::Spider, 40.0, 40.0, |x, z| {
            room.world.surface_y(x, z)
        });
        let feet = spider.pos[1];
        let p = room.players.get_mut(&1).unwrap();
        p.x = 40.0;
        p.z = 40.0;
        p.y = feet + PLAYER_EYE_HEIGHT;
        p.hurt_at = Instant::now() - Duration::from_secs(5);
        room.creatures.clear();
        room.creatures.push(spider);
    }

    #[tokio::test]
    async fn a_hostile_creature_bite_drops_a_heart_server_side() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        bite_setup(&mut room);
        room.simulate_creatures(0.1);
        assert_eq!(room.players.get(&1).unwrap().hp, MAX_HP - 1);
    }

    // End-to-end of the co-op damage the players keep reporting as broken: a player who synced onto open
    // ground (first move is the anti-cheat baseline, so the server tracks their real position) is chased
    // by a hostile creature spawned several blocks away, which closes the gap and bites — dropping a
    // heart server-side and pushing a Hurt cue. If this holds, broken co-op damage is a stale deploy
    // (the player wedged at the old centre spawn), not the combat logic.
    #[tokio::test]
    async fn a_hostile_creature_chases_a_synced_player_and_bites() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        room.peace = false;
        let feet = room.world.surface_y(60, 60) as f32;
        room.on_input(
            1,
            ClientMsg::Move {
                x: 60.0,
                y: feet + PLAYER_EYE_HEIGHT,
                z: 60.0,
                yaw: 0.0,
                pitch: 0.0,
            },
        );
        room.players.get_mut(&1).unwrap().hurt_at = Instant::now() - Duration::from_secs(5);
        let spider = Creature::spawn(99, CreatureKind::Spider, 65.0, 60.0, |x, z| {
            room.world.surface_y(x, z)
        });
        room.creatures.clear();
        room.creatures.push(spider);
        let start = room.players.get(&1).unwrap().hp;
        for _ in 0..200 {
            room.simulate_creatures(0.1);
        }
        let hp = room.players.get(&1).unwrap().hp;
        assert!(
            hp < start,
            "the chaser should reach and bite (hp {start} -> {hp})"
        );
        let hurt =
            std::iter::from_fn(|| rx.try_recv().ok()).any(|m| matches!(m, ServerMsg::Hurt { .. }));
        assert!(hurt, "the bitten player gets a Hurt cue");
    }

    #[tokio::test]
    async fn a_bite_that_empties_the_hearts_respawns_at_spawn() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        bite_setup(&mut room);
        room.players.get_mut(&1).unwrap().hp = 1;
        room.simulate_creatures(0.1);
        let spawn = World::spawn();
        let p = room.players.get(&1).unwrap();
        assert_eq!(p.hp, MAX_HP);
        assert_eq!(p.x, spawn[0]);
        assert!(
            (0..50)
                .filter_map(|_| rx.try_recv().ok())
                .any(|m| matches!(m, ServerMsg::Respawn { .. })),
            "the player is told it respawned",
        );
    }

    #[tokio::test]
    async fn respawn_request_recenters_refills_and_notifies() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        {
            let p = room.players.get_mut(&1).unwrap();
            p.x = 200.0;
            p.hp = 1;
            p.move_synced = true;
        }
        room.on_input(1, ClientMsg::Respawn);
        let spawn = World::spawn();
        let p = room.players.get(&1).unwrap();
        assert_eq!(p.x, spawn[0]);
        assert_eq!(p.hp, MAX_HP);
        assert!(
            !p.move_synced,
            "the anti-cheat baseline resets so the snap is accepted"
        );
        assert!((0..50)
            .filter_map(|_| rx.try_recv().ok())
            .any(|m| matches!(m, ServerMsg::Respawn { .. })),);
    }

    #[tokio::test]
    async fn pvp_hit_drops_the_targets_heart_on_the_server() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        add_player(&mut room, 2, false);
        room.pvp = true;
        for id in [1, 2] {
            let p = room.players.get_mut(&id).unwrap();
            p.x = 0.0;
            p.y = 0.0;
            p.z = 0.0;
        }
        room.on_attack_player(1, 2);
        assert_eq!(room.players.get(&2).unwrap().hp, MAX_HP - 1);
        assert_eq!(
            room.players.get(&1).unwrap().hp,
            MAX_HP,
            "the attacker is unharmed"
        );
    }

    #[tokio::test]
    async fn dig_breaks_only_after_enough_taps_and_resets_on_switch() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        room.world.set(10, 20, 10, 1);
        room.world.set(11, 20, 10, 1);
        {
            let p = room.players.get_mut(&1).unwrap();
            p.x = 10.5;
            p.y = 21.0;
            p.z = 10.5;
        }
        for _ in 0..DIG_HITS - 1 {
            room.on_dig(1, 10, 20, 10);
        }
        assert!(
            room.world.is_solid(10, 20, 10),
            "fewer than DIG_HITS taps leave it standing"
        );
        // switching blocks resets the counter, so the original needs a fresh full set of taps
        room.on_dig(1, 11, 20, 10);
        for _ in 0..DIG_HITS - 1 {
            room.on_dig(1, 10, 20, 10);
        }
        assert!(room.world.is_solid(10, 20, 10), "the switch reset progress");
        room.on_dig(1, 10, 20, 10);
        assert!(!room.world.is_solid(10, 20, 10), "the final tap breaks it");
        assert!(
            (0..50)
                .filter_map(|_| rx.try_recv().ok())
                .any(|m| matches!(m, ServerMsg::Edit { id: 0, .. })),
            "the break is broadcast",
        );
    }

    #[tokio::test]
    async fn roster_carries_every_players_identity_so_the_snapshot_can_stay_slim() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        add_player(&mut room, 2, true);
        {
            let p = room.players.get_mut(&1).unwrap();
            p.name = "Alice".into();
            p.skin = "#abc123".into();
        }
        let ServerMsg::Roster { players } = room.roster_msg() else {
            panic!("expected a roster message");
        };
        assert_eq!(players.len(), 2);
        let alice = players.iter().find(|p| p.id == 1).unwrap();
        assert_eq!(alice.name, "Alice");
        assert_eq!(alice.skin, "#abc123");
        // The role rides along so the lobby/admin UI can badge admins without a separate query.
        assert!(!alice.admin);
        assert!(players.iter().find(|p| p.id == 2).unwrap().admin);
    }

    #[tokio::test]
    async fn an_admin_can_session_promote_a_guest_who_then_rides_the_roster() {
        let mut room = test_room().await;
        add_player(&mut room, 1, true); // the admin
        let mut guest_rx = add_player(&mut room, 2, false);
        room.players.get_mut(&2).unwrap().account_id = String::new(); // an anonymous guest

        room.on_admin_set_role(1, 2, protocol::Role::Moderator);

        // Applied live (session-only, no account to persist) and pushed to the guest + the roster.
        assert!(room.players.get(&2).unwrap().is_moderator);
        let got_role = std::iter::from_fn(|| guest_rx.try_recv().ok()).any(|m| {
            matches!(
                m,
                ServerMsg::Role {
                    moderator: true,
                    ..
                }
            )
        });
        assert!(got_role, "the promoted guest is told their new role");
        let ServerMsg::Roster { players } = room.roster_msg() else {
            panic!("expected a roster message");
        };
        assert!(players.iter().find(|p| p.id == 2).unwrap().moderator);
    }

    #[tokio::test]
    async fn digging_a_block_banks_it_to_the_diggers_inventory() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        room.world.set(10, 20, 10, 1);
        {
            let p = room.players.get_mut(&1).unwrap();
            p.x = 10.5;
            p.y = 21.0;
            p.z = 10.5;
        }
        for _ in 0..DIG_HITS {
            room.on_dig(1, 10, 20, 10);
        }
        assert!(!room.world.is_solid(10, 20, 10), "the block broke");
        assert_eq!(
            room.players.get(&1).unwrap().inventory.get(&1),
            Some(&1),
            "the dug block was banked to the digger",
        );
    }

    #[tokio::test]
    async fn admin_reset_scores_zeroes_players_and_broadcasts() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        add_player(&mut room, 2, false);
        room.players.get_mut(&1).unwrap().score = 5;
        room.players.get_mut(&2).unwrap().score = 9;
        room.on_admin_reset_scores(1);
        assert_eq!(room.players.get(&1).unwrap().score, 0);
        assert_eq!(room.players.get(&2).unwrap().score, 0);
        assert!(
            (0..50)
                .filter_map(|_| admin_rx.try_recv().ok())
                .any(|m| matches!(m, ServerMsg::Event { kind, .. } if kind == "reset_scores")),
            "the reset is announced in the feed",
        );
    }

    #[tokio::test]
    async fn non_admin_reset_scores_is_ignored() {
        let mut room = test_room().await;
        add_player(&mut room, 2, false);
        room.players.get_mut(&2).unwrap().score = 7;
        room.on_admin_reset_scores(2);
        assert_eq!(room.players.get(&2).unwrap().score, 7);
    }

    #[tokio::test]
    async fn admin_suspend_clears_the_room_then_an_admin_resumes() {
        let mut room = test_room().await;
        add_player(&mut room, 1, true);
        add_player(&mut room, 2, false);
        room.on_admin_suspend(1, true);
        assert!(room.suspended);
        assert!(
            !room.players.contains_key(&2),
            "the player is sent to the lobby"
        );
        assert!(room.players.contains_key(&1), "the admin stays to resume");
        room.on_admin_suspend(1, false);
        assert!(!room.suspended);
    }

    #[tokio::test]
    async fn non_admin_suspend_is_ignored() {
        let mut room = test_room().await;
        add_player(&mut room, 2, false);
        room.on_admin_suspend(2, true);
        assert!(!room.suspended);
    }

    #[tokio::test]
    async fn admin_blocks_then_reallows_a_structure() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);

        room.on_admin_setting(
            1,
            ClientMsg::AdminSetStructure {
                kind: "trophy".into(),
                allowed: false,
            },
        );
        assert!(room.blocked_structures.contains("trophy"));
        assert_eq!(
            drain_room_state(&mut admin_rx),
            Some((true, vec!["trophy".to_string()]))
        );

        room.on_admin_setting(
            1,
            ClientMsg::AdminSetStructure {
                kind: "trophy".into(),
                allowed: true,
            },
        );
        assert!(room.blocked_structures.is_empty());
        assert_eq!(drain_room_state(&mut admin_rx), Some((true, vec![])));
    }

    #[tokio::test]
    async fn non_admin_structure_block_is_ignored() {
        let mut room = test_room().await;
        let mut other_rx = add_player(&mut room, 2, false);

        room.on_admin_setting(
            2,
            ClientMsg::AdminSetStructure {
                kind: "ball".into(),
                allowed: false,
            },
        );
        assert!(room.blocked_structures.is_empty());
        assert_eq!(drain_room_state(&mut other_rx), None);
    }

    #[tokio::test]
    async fn invalid_structure_kind_is_rejected_without_broadcast() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);

        room.on_admin_setting(
            1,
            ClientMsg::AdminSetStructure {
                kind: "BAD!".into(),
                allowed: false,
            },
        );
        assert!(room.blocked_structures.is_empty());
        assert_eq!(drain_room_state(&mut admin_rx), None);
    }

    #[tokio::test]
    async fn unchanged_setting_does_not_rebroadcast() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);

        room.on_admin_setting(1, ClientMsg::AdminSetPeace { on: true });
        assert_eq!(drain_room_state(&mut admin_rx), None);
    }

    #[tokio::test]
    async fn admin_toggles_pvp_and_chat_and_broadcasts() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let mut other_rx = add_player(&mut room, 2, false);
        assert!(!room.pvp);
        assert!(room.chat_enabled);

        room.on_input(1, ClientMsg::AdminSetPvp { on: true });
        assert!(room.pvp);
        assert_eq!(drain_pvp_chat(&mut admin_rx), Some((true, true)));
        assert_eq!(drain_pvp_chat(&mut other_rx), Some((true, true)));

        room.on_input(1, ClientMsg::AdminSetChat { on: false });
        assert!(!room.chat_enabled);
        assert_eq!(drain_pvp_chat(&mut admin_rx), Some((true, false)));
    }

    #[tokio::test]
    async fn non_admin_pvp_and_chat_toggles_are_ignored() {
        let mut room = test_room().await;
        let mut other_rx = add_player(&mut room, 2, false);

        room.on_input(2, ClientMsg::AdminSetPvp { on: true });
        room.on_input(2, ClientMsg::AdminSetChat { on: false });
        assert!(!room.pvp);
        assert!(room.chat_enabled);
        assert_eq!(drain_pvp_chat(&mut other_rx), None);
    }

    #[tokio::test]
    async fn chat_is_dropped_when_disabled() {
        let mut room = test_room().await;
        let mut listener_rx = add_player(&mut room, 2, false);
        let _sender_rx = add_player(&mut room, 1, false);
        room.chat_enabled = false;

        room.on_input(1, ClientMsg::Chat { text: "hi".into() });
        let chats: Vec<ServerMsg> = std::iter::from_fn(|| listener_rx.try_recv().ok())
            .filter(|m| matches!(m, ServerMsg::Chat { .. }))
            .collect();
        assert!(chats.is_empty(), "a disabled room must drop chat");
    }

    #[tokio::test]
    async fn admin_kick_removes_target_and_broadcasts_left() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let mut target_rx = add_player(&mut room, 2, false);

        room.on_input(1, ClientMsg::AdminKick { id: 2 });
        assert!(
            !room.players.contains_key(&2),
            "the kicked player is removed"
        );
        assert!(room.players.contains_key(&1));
        assert!(drain_left(&mut admin_rx).contains(&2));
        let target_msgs: Vec<ServerMsg> =
            std::iter::from_fn(|| target_rx.try_recv().ok()).collect();
        assert!(target_msgs
            .iter()
            .any(|m| matches!(m, ServerMsg::Error { code, .. } if code == "kicked")));
    }

    #[tokio::test]
    async fn non_admin_kick_is_ignored() {
        let mut room = test_room().await;
        let _other_rx = add_player(&mut room, 2, false);
        let _target_rx = add_player(&mut room, 3, false);

        room.on_input(2, ClientMsg::AdminKick { id: 3 });
        assert!(room.players.contains_key(&3), "a non-admin cannot kick");
    }

    #[tokio::test]
    async fn admin_ban_bans_the_ip_and_removes_target() {
        // The ban store is db-backed (each test_room has its own in-memory db), so there is nothing to
        // point at a throwaway file anymore.
        let mut room = test_room().await;
        let _admin_rx = add_player(&mut room, 1, true);
        let _target_rx = add_player(&mut room, 2, false);
        let target_ip: IpAddr = "203.0.113.9".parse().unwrap();
        room.players.get_mut(&2).unwrap().ip = target_ip;

        room.on_input(1, ClientMsg::AdminBan { id: 2 });
        assert!(
            !room.players.contains_key(&2),
            "the banned player is removed"
        );
        assert!(room.hub.bans.is_banned(target_ip), "the ip is banned");
    }

    #[tokio::test]
    async fn pvp_off_never_hurts_a_player() {
        let mut room = test_room().await;
        let _attacker_rx = add_player(&mut room, 1, false);
        let mut target_rx = add_player(&mut room, 2, false);

        room.on_input(1, ClientMsg::AttackPlayer { id: 2 });
        assert_eq!(drain_hurt(&mut target_rx), None, "no pvp means no damage");
    }

    #[tokio::test]
    async fn pvp_on_hurts_target_in_range_only() {
        let mut room = test_room().await;
        let mut attacker_rx = add_player(&mut room, 1, false);
        let mut target_rx = add_player(&mut room, 2, false);
        room.pvp = true;
        // Target on top of the attacker (both at origin), well within MELEE_RANGE.
        room.on_input(1, ClientMsg::AttackPlayer { id: 2 });
        assert_eq!(drain_hurt(&mut target_rx), Some("p1".into()));
        // The attacker never receives a Hurt of its own.
        assert_eq!(drain_hurt(&mut attacker_rx), None);

        // A far target is out of range and takes no damage.
        room.players.get_mut(&2).unwrap().x = 100.0;
        room.on_input(1, ClientMsg::AttackPlayer { id: 2 });
        assert_eq!(drain_hurt(&mut target_rx), None);
    }

    fn drain_kill_event(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<(String, String)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::Event { kind, name, detail } = msg {
                if kind == "kill" {
                    latest = Some((name, detail));
                }
            }
        }
        latest
    }

    #[tokio::test]
    async fn hit_in_range_kills_and_awards_score() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        // A chicken (1 hp) right on top of the attacker at the origin.
        room.creatures.push(Creature::spawn(
            50,
            CreatureKind::Chicken,
            0.0,
            0.0,
            sim::height_at,
        ));
        room.players.get_mut(&1).unwrap().y = sim::height_at(0, 0) as f32 + 0.5;

        room.on_input(1, ClientMsg::Hit { id: 50 });
        assert!(room.creatures.is_empty(), "the creature should be dead");
        assert_eq!(room.players.get(&1).unwrap().score, 1);
        assert_eq!(
            drain_kill_event(&mut rx),
            Some(("p1".into(), "chicken".into()))
        );
    }

    #[tokio::test]
    async fn hit_out_of_range_is_ignored() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        room.creatures.push(Creature::spawn(
            51,
            CreatureKind::Chicken,
            100.0,
            100.0,
            sim::height_at,
        ));

        room.on_input(1, ClientMsg::Hit { id: 51 });
        assert_eq!(room.creatures.len(), 1, "a far creature must not be hit");
        assert_eq!(room.players.get(&1).unwrap().score, 0);
    }

    #[tokio::test]
    async fn multi_hp_creature_survives_one_hit() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        room.players.get_mut(&1).unwrap().y = sim::height_at(0, 0) as f32 + 0.5;
        room.creatures.push(Creature::spawn(
            52,
            CreatureKind::Cow,
            0.0,
            0.0,
            sim::height_at,
        ));

        room.on_input(1, ClientMsg::Hit { id: 52 });
        assert_eq!(room.creatures.len(), 1, "a 3-hp cow survives the first hit");
        assert_eq!(room.creatures[0].hp, 2);
        assert_eq!(
            room.players.get(&1).unwrap().score,
            0,
            "no reward until death"
        );
    }

    #[tokio::test]
    async fn empty_room_clears_creatures() {
        let mut room = test_room().await;
        room.creatures.push(Creature::spawn(
            53,
            CreatureKind::Pig,
            0.0,
            0.0,
            sim::height_at,
        ));
        room.simulate_creatures(0.05);
        assert!(room.creatures.is_empty(), "no players means no creatures");
    }

    fn drain_reset_event(rx: &mut mpsc::Receiver<ServerMsg>) -> Option<String> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::Event { kind, name, .. } = msg {
                if kind == "reset" {
                    latest = Some(name);
                }
            }
        }
        latest
    }

    #[tokio::test]
    async fn admin_reset_clears_world_and_creatures_and_broadcasts() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let mut other_rx = add_player(&mut room, 2, false);
        room.world.set(5, 6, 7, sim::STONE);
        room.creatures.push(Creature::spawn(
            9,
            CreatureKind::Pig,
            0.0,
            0.0,
            sim::height_at,
        ));
        room.next_creature_id = 42;

        room.on_input(1, ClientMsg::AdminResetWorld);
        assert_eq!(room.world.edit_count(), 0, "all edits are wiped");
        assert!(room.creatures.is_empty(), "all creatures are cleared");
        assert_eq!(room.next_creature_id, 1, "the id counter is reset");
        assert_eq!(drain_reset_event(&mut admin_rx), Some("p1".into()));
        assert_eq!(drain_reset_event(&mut other_rx), Some("p1".into()));
    }

    #[tokio::test]
    async fn non_admin_reset_is_ignored() {
        let mut room = test_room().await;
        let mut other_rx = add_player(&mut room, 2, false);
        room.world.set(5, 6, 7, sim::STONE);

        room.on_input(2, ClientMsg::AdminResetWorld);
        assert_eq!(room.world.edit_count(), 1, "a non-admin cannot reset");
        assert_eq!(drain_reset_event(&mut other_rx), None);
    }

    #[tokio::test]
    async fn admin_promotes_a_player_to_moderator_who_can_reset_but_not_toggle_chat() {
        let mut room = test_room().await;
        add_player(&mut room, 1, true); // admin (parent)
        add_player(&mut room, 2, false); // plain player (kid)

        // A plain player can neither reset nor be hit by the chat toggle.
        room.world.set(5, 6, 7, sim::STONE);
        room.on_input(2, ClientMsg::AdminResetWorld);
        assert_eq!(room.world.edit_count(), 1, "a plain player cannot reset");

        // The admin promotes the kid to moderator.
        room.on_input(
            1,
            ClientMsg::AdminSetRole {
                id: 2,
                role: protocol::Role::Moderator,
            },
        );
        assert!(room.players.get(&2).unwrap().is_moderator);

        // Now the moderator may reset the world (a harmless toggle)...
        room.on_input(2, ClientMsg::AdminResetWorld);
        assert_eq!(room.world.edit_count(), 0, "a moderator may reset");

        // ...but may NOT toggle chat (parents-only).
        room.on_input(2, ClientMsg::AdminSetChat { on: false });
        assert!(room.chat_enabled, "a moderator cannot toggle chat");
    }

    #[tokio::test]
    async fn a_moderator_cannot_grant_admin() {
        let mut room = test_room().await;
        add_player(&mut room, 1, true);
        room.on_input(
            1,
            ClientMsg::AdminSetRole {
                id: 2,
                role: protocol::Role::Moderator,
            },
        );
        add_player(&mut room, 2, false);
        room.players.get_mut(&2).unwrap().is_moderator = true;
        add_player(&mut room, 3, false);

        room.on_input(
            2,
            ClientMsg::AdminSetRole {
                id: 3,
                role: protocol::Role::Admin,
            },
        );
        assert!(
            !room.players.get(&3).unwrap().is_admin,
            "a moderator cannot grant admin"
        );

        room.on_input(
            2,
            ClientMsg::AdminSetRole {
                id: 3,
                role: protocol::Role::Moderator,
            },
        );
        assert!(
            room.players.get(&3).unwrap().is_moderator,
            "a moderator may add another moderator"
        );
    }

    #[tokio::test]
    async fn guest_joins_without_a_claim_and_gets_a_unique_name() {
        let mut room = test_room().await;
        let (conn, _conn_rx) = mpsc::channel::<ServerMsg>(64);
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        room.on_join(
            String::new(),
            String::new(),
            look,
            "127.0.0.1".parse().unwrap(),
            conn,
            reply,
        )
        .await;
        let id = reply_rx
            .await
            .unwrap()
            .expect("a guest joins with no claim");
        let player = room.players.get(&id).unwrap();
        assert_eq!(player.name, format!("Guest{id}"));
        assert!(player.account_id.is_empty(), "a guest has no account");
    }

    /// Drive `admit` for a logged-in account with the given id/name/role and return its outcome plus
    /// the captured connection. Mirrors the on_join → admit path without the claim resolution.
    async fn admit_account(
        room: &mut Room,
        account_id: &str,
        name: &str,
        role: Role,
    ) -> (Result<PlayerId, String>, mpsc::Receiver<ServerMsg>) {
        let (conn, conn_rx) = mpsc::channel::<ServerMsg>(64);
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        room.admit(
            account_id.to_string(),
            name.to_string(),
            role,
            "claim".into(),
            look,
            "127.0.0.1".parse().unwrap(),
            conn,
            reply,
        )
        .await;
        (reply_rx.await.unwrap(), conn_rx)
    }

    #[tokio::test]
    async fn approval_off_by_default_lets_everyone_in() {
        let mut room = test_room().await;
        let acc = room
            .hub
            .db
            .claim_account("teo", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;
        let (result, _rx) = admit_account(&mut room, &acc, "Kid", Role::Player).await;
        assert!(result.is_ok(), "approval off admits a normal player");
    }

    #[tokio::test]
    async fn approval_required_refuses_unapproved_then_admits_after_approve() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        let acc = room
            .hub
            .db
            .claim_account("teo", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;

        let (refused, mut rx) = admit_account(&mut room, &acc, "Kid", Role::Player).await;
        assert_eq!(refused, Err("needs_approval".into()));
        let coded = std::iter::from_fn(|| rx.try_recv().ok()).find_map(|m| match m {
            ServerMsg::Error { code, .. } => Some(code),
            _ => None,
        });
        assert_eq!(coded.as_deref(), Some("needs_approval"));
        // The held-out account is now pending.
        let pending = room.hub.db.pending_approvals("teo").await.unwrap();
        assert_eq!(pending.len(), 1);

        // After an admin approves it, the same account is admitted.
        room.hub.db.approve_account("teo", &acc).await.unwrap();
        let (allowed, _rx2) = admit_account(&mut room, &acc, "Kid", Role::Player).await;
        assert!(allowed.is_ok(), "an approved account is admitted");
    }

    #[tokio::test]
    async fn approval_required_always_admits_admins() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        let acc = room
            .hub
            .db
            .claim_account("teo", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        let (result, _rx) = admit_account(&mut room, &acc, "Parent", Role::Admin).await;
        assert!(result.is_ok(), "an admin is never held out by the gate");
        assert!(
            room.hub
                .db
                .pending_approvals("teo")
                .await
                .unwrap()
                .is_empty(),
            "an admin never becomes a pending request"
        );
    }

    #[tokio::test]
    async fn approval_required_refuses_a_guest_with_needs_login() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        let (refused, _rx) = admit_account(&mut room, "", "", Role::Player).await;
        assert_eq!(refused, Err("needs_login".into()));
    }

    #[tokio::test]
    async fn admin_toggles_approval_and_approves_a_pending_account() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let acc = room
            .hub
            .db
            .claim_account("teo", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;

        room.on_input(1, ClientMsg::AdminSetApproval { on: true });
        assert!(room.approval_required);
        let required = std::iter::from_fn(|| admin_rx.try_recv().ok()).find_map(|m| match m {
            ServerMsg::RoomState {
                approval_required, ..
            } => Some(approval_required),
            _ => None,
        });
        assert_eq!(required, Some(true), "the toggle broadcasts RoomState");

        room.hub
            .db
            .record_approval_request("teo", &acc, "Kid", "kid@x.com")
            .await
            .unwrap();
        room.on_input(
            1,
            ClientMsg::AdminApprove {
                account_id: acc.clone(),
            },
        );
        // The approve is spawned async; let it run, then confirm the account is approved + cleared.
        tokio::task::yield_now().await;
        for _ in 0..50 {
            if room.hub.db.is_approved("teo", &acc).await.unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(room.hub.db.is_approved("teo", &acc).await.unwrap());
        assert!(room
            .hub
            .db
            .pending_approvals("teo")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn non_admin_approval_toggle_is_ignored() {
        let mut room = test_room().await;
        add_player(&mut room, 2, false);
        room.on_input(2, ClientMsg::AdminSetApproval { on: true });
        assert!(
            !room.approval_required,
            "a non-admin cannot turn approval on"
        );
    }

    #[tokio::test]
    async fn creatures_keep_a_minimum_population_near_players_and_refill() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        for _ in 0..200 {
            room.tick += 1;
            room.simulate_creatures(0.05);
        }
        let ramped = room.creatures.len();
        assert!(
            ramped >= MIN_CREATURES,
            "a player area must keep at least the floor population, got {ramped}"
        );
        assert!(
            ramped <= MAX_CREATURES,
            "never exceed the ceiling, got {ramped}"
        );
        // Wipe them (as if all were killed) and confirm the area repopulates.
        room.creatures.clear();
        for _ in 0..(SPAWN_EVERY_TICKS * 5) {
            room.tick += 1;
            room.simulate_creatures(0.05);
        }
        assert!(
            !room.creatures.is_empty(),
            "the area must refill after a wipe so players never run dry"
        );
    }

    #[test]
    fn valid_structure_kind_accepts_slugs_and_rejects_junk() {
        assert_eq!(valid_structure_kind(" trophy "), Some("trophy".to_string()));
        assert_eq!(valid_structure_kind("steve2"), Some("steve2".to_string()));
        assert!(valid_structure_kind("").is_none());
        assert!(valid_structure_kind("Trophy").is_none());
        assert!(valid_structure_kind("a b").is_none());
        assert!(valid_structure_kind(&"x".repeat(MAX_STRUCTURE_KIND_LEN + 1)).is_none());
    }

    #[test]
    fn bucket_limits_and_refills() {
        // capacity 3: three takes succeed, fourth fails until refilled.
        let mut b = Bucket::new(3.0);
        assert!(b.take());
        assert!(b.take());
        assert!(b.take());
        assert!(!b.take(), "bucket should be empty");
        b.refill(1.0); // 1s at 3/s -> +3 tokens (capped at 3)
        assert!(b.take());
    }

    #[test]
    fn bucket_caps_at_capacity() {
        let mut b = Bucket::new(2.0);
        b.refill(100.0); // huge refill must not exceed capacity
        assert!(b.take());
        assert!(b.take());
        assert!(!b.take());
    }

    /// The latest inventory message's (count for a block, infinite flag), or None if none was sent.
    fn drain_inventory(rx: &mut mpsc::Receiver<ServerMsg>, block: u8) -> Option<(u32, bool)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMsg::Inventory { items, infinite } = msg {
                let count = items.iter().find(|i| i.id == block).map(|i| i.count);
                latest = Some((count.unwrap_or(0), infinite));
            }
        }
        latest
    }

    // Stand the player on a block so its edits are within reach.
    fn place_player_at(room: &mut Room, id: PlayerId, x: i32, y: i32, z: i32) {
        let p = room.players.get_mut(&id).unwrap();
        p.x = x as f32 + 0.5;
        p.y = y as f32 + 0.5;
        p.z = z as f32 + 0.5;
    }

    #[tokio::test]
    async fn breaking_a_block_banks_it_in_the_inventory() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        room.world.set(10, 20, 10, sim::STONE);
        place_player_at(&mut room, 1, 10, 20, 10);

        room.on_input(
            1,
            ClientMsg::Edit {
                op: EditOp::Break,
                x: 10,
                y: 20,
                z: 10,
                id: 0,
            },
        );
        assert_eq!(
            room.players.get(&1).unwrap().inventory.get(&sim::STONE),
            Some(&1)
        );
        assert_eq!(drain_inventory(&mut rx, sim::STONE), Some((1, true)));
    }

    #[tokio::test]
    async fn placing_without_the_block_is_rejected_and_not_broadcast() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        let mut other_rx = add_player(&mut room, 2, false);
        room.world.set(10, 20, 11, sim::AIR);
        place_player_at(&mut room, 1, 10, 20, 10);
        // A non-infinite player holding nothing cannot place: the cell stays air and nothing is sent.
        room.players.get_mut(&1).unwrap().infinite = false;

        room.on_input(
            1,
            ClientMsg::Edit {
                op: EditOp::Place,
                x: 10,
                y: 20,
                z: 11,
                id: sim::STONE,
            },
        );
        assert_eq!(
            room.world.get(10, 20, 11),
            sim::AIR,
            "the place was rejected"
        );
        let placed = std::iter::from_fn(|| other_rx.try_recv().ok())
            .any(|m| matches!(m, ServerMsg::Edit { .. }));
        assert!(!placed, "a rejected place is never broadcast");
        let _ = rx.try_recv();
    }

    #[tokio::test]
    async fn placing_spends_a_banked_block_when_not_infinite() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        room.world.set(10, 20, 11, sim::AIR);
        place_player_at(&mut room, 1, 10, 20, 10);
        {
            let p = room.players.get_mut(&1).unwrap();
            p.infinite = false;
            p.inventory.insert(sim::STONE, 1);
        }

        room.on_input(
            1,
            ClientMsg::Edit {
                op: EditOp::Place,
                x: 10,
                y: 20,
                z: 11,
                id: sim::STONE,
            },
        );
        assert_eq!(
            room.world.get(10, 20, 11),
            sim::STONE,
            "the place was applied"
        );
        assert_eq!(
            room.players.get(&1).unwrap().inventory.get(&sim::STONE),
            Some(&0)
        );
        assert_eq!(drain_inventory(&mut rx, sim::STONE), Some((0, false)));
    }

    #[tokio::test]
    async fn infinite_player_places_without_spending() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        room.world.set(10, 20, 11, sim::AIR);
        place_player_at(&mut room, 1, 10, 20, 10);
        // infinite is true by default; placing must not require nor decrement the inventory.
        room.on_input(
            1,
            ClientMsg::Edit {
                op: EditOp::Place,
                x: 10,
                y: 20,
                z: 11,
                id: sim::STONE,
            },
        );
        assert_eq!(
            room.world.get(10, 20, 11),
            sim::STONE,
            "an infinite player places freely"
        );
        assert!(room.players.get(&1).unwrap().inventory.is_empty());
    }

    #[tokio::test]
    async fn admin_toggles_a_players_infinite_flag_and_sends_inventory() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, true);
        assert!(room.players.get(&1).unwrap().infinite);

        room.on_input(1, ClientMsg::AdminSetInfinite { on: false });
        assert!(!room.players.get(&1).unwrap().infinite);
        assert_eq!(drain_inventory(&mut rx, sim::STONE), Some((0, false)));
    }

    #[tokio::test]
    async fn non_admin_infinite_toggle_is_ignored() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 2, false);
        room.on_input(2, ClientMsg::AdminSetInfinite { on: false });
        assert!(
            room.players.get(&2).unwrap().infinite,
            "a non-admin cannot toggle"
        );
    }

    #[test]
    fn bank_and_spend_track_counts() {
        let mut inventory = HashMap::new();
        assert!(!spend_block(&mut inventory, sim::STONE), "nothing to spend");
        bank_block(&mut inventory, sim::STONE);
        bank_block(&mut inventory, sim::STONE);
        assert_eq!(inventory.get(&sim::STONE), Some(&2));
        assert!(spend_block(&mut inventory, sim::STONE));
        assert_eq!(inventory.get(&sim::STONE), Some(&1));
        assert!(spend_block(&mut inventory, sim::STONE));
        assert!(!spend_block(&mut inventory, sim::STONE), "depleted");
    }
}
