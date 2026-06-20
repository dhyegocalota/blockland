//! One authoritative room per (tenant, world). Runs a fixed-rate tick, owns the world
//! state, validates every client input, and broadcasts snapshots. The server is the
//! single source of truth; clients predict locally and reconcile from snapshots.

use std::collections::{BTreeSet, HashMap};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{
    Brand, ClientMsg, CreatureState, EditCell, EditOp, PlayerId, PlayerState, ServerMsg,
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
// A player must be within this distance of a creature for a Hit to land (anti-cheat melee range).
const MELEE_RANGE: f32 = 4.0;

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
}

const PING_EVERY_TICKS: u64 = 60; // 2s @ 30Hz
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30);
const PERSIST_SECS: u64 = 10; // flush the world diff at most this often, only when dirty

impl Room {
    pub fn new(
        hub: Arc<Hub>,
        tcfg: &TenantCfg,
        world: String,
        rx: mpsc::Receiver<RoomCmd>,
    ) -> Self {
        let brand = Brand {
            name: tcfg.name.clone(),
            primary: tcfg.primary.clone(),
            logo: tcfg.logo.clone(),
        };
        // Restore the tenant's persisted world (procedural base + saved edits).
        let mut world_state = World::new();
        if let Some(blob) = crate::persistence::load(&tcfg.id) {
            match sim::decode_edits(&blob) {
                Ok(items) => {
                    world_state.load_edits(&items);
                    tracing::info!(tenant = %tcfg.id, edits = items.len(), "world restored");
                }
                Err(e) => {
                    tracing::error!(tenant = %tcfg.id, error = %e, "failed to decode world blob")
                }
            }
        }
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
            peace: false,
            blocked_structures: BTreeSet::new(),
            pvp: false,
            chat_enabled: true,
            creatures: Vec::new(),
            next_creature_id: 1,
            hub,
        }
    }

    pub async fn run(mut self) {
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
        // Final synchronous save so nothing is lost when the room closes.
        if self.dirty {
            let blob = sim::encode_edits(&self.world.snapshot());
            if let Err(e) = crate::persistence::save(&self.key.0, &blob) {
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
        self.players.insert(id, player);
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

        // Admin kick/ban remove another player, so they touch the whole player map and are handled
        // before the single-player borrow below.
        if let ClientMsg::AdminKick { id: target } | ClientMsg::AdminBan { id: target } = msg {
            self.on_admin_remove(id, target, matches!(msg, ClientMsg::AdminBan { .. }));
            return;
        }

        // Resetting the world wipes shared state (edits + creatures), so it is handled before the
        // single-player borrow below.
        if let ClientMsg::AdminResetWorld = msg {
            self.on_admin_reset_world(id);
            return;
        }

        // Role changes touch another account + the whole player map, so handle before the borrow.
        if let ClientMsg::AdminSetRole { id: target, role } = msg {
            self.on_admin_set_role(id, target, role);
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

        // Edits and chat need a broadcast after the borrow ends, so stage them.
        let mut edit_out: Option<ServerMsg> = None;
        let mut chat_out: Option<ServerMsg> = None;
        let mut batch_out: Option<ServerMsg> = None;

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
                if dist <= allowed && in_world && x.is_finite() && y.is_finite() && z.is_finite() {
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
                    EditOp::Break => sim::AIR,
                    EditOp::Place => {
                        if block == 0 || block > sim::MAX_BLOCK {
                            return;
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
            | ClientMsg::AdminKick { .. }
            | ClientMsg::AdminBan { .. }
            | ClientMsg::AdminResetWorld
            | ClientMsg::AdminSetRole { .. }
            | ClientMsg::AttackPlayer { .. }
            | ClientMsg::Hit { .. } => { /* handled before the per-player borrow above */ }
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
        if target.account_id.is_empty() {
            tracing::debug!(%target_id, "set-role ignored: target is a guest");
            return;
        }
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
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_role(&target_account, role).await {
                tracing::error!(error = %e, "set_role persist failed");
            }
        });
        tracing::info!(tenant = %self.key.0, %actor_id, %target_id, ?role, "role changed in-game");
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
        let dist = ((target.x - attacker_x).powi(2)
            + (target.y - attacker_y).powi(2)
            + (target.z - attacker_z).powi(2))
        .sqrt();
        if dist > MELEE_RANGE {
            tracing::debug!(%attacker_id, %target_id, dist, "pvp attack rejected: out of range");
            return;
        }
        let _ = target.conn.try_send(ServerMsg::Hurt { by: attacker_name });
        // Everyone but the attacker sees the same hit effect on the target.
        self.broadcast_except(
            attacker_id,
            &ServerMsg::Attack {
                kind: "player".into(),
                id: target_id,
            },
        );
        tracing::debug!(tenant = %self.key.0, %attacker_id, %target_id, "pvp hit");
    }

    /// Snapshot the room-wide settings as the wire message broadcast on change and sent on join.
    fn room_state(&self) -> ServerMsg {
        ServerMsg::RoomState {
            peace: self.peace,
            blocked_structures: self.blocked_structures.iter().cloned().collect(),
            pvp: self.pvp,
            chat_enabled: self.chat_enabled,
        }
    }

    fn tick(&mut self, dt: f32) -> bool {
        self.tick += 1;

        // Refill rate buckets and find idle players to drop.
        let idle = Duration::from_secs(self.hub.limits.idle_secs);
        let now = Instant::now();
        let mut kicked: Vec<PlayerId> = Vec::new();
        for p in self.players.values_mut() {
            p.move_b.refill(dt);
            p.edit_b.refill(dt);
            p.chat_b.refill(dt);
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

        // Broadcast the world snapshot.
        let states: Vec<PlayerState> = self
            .players
            .values()
            .map(|p| PlayerState {
                id: p.id,
                name: p.name.clone(),
                skin: p.skin.clone(),
                shirt: p.shirt.clone(),
                hair: p.hair.clone(),
                x: p.x,
                y: p.y,
                z: p.z,
                yaw: p.yaw,
                pitch: p.pitch,
                ping_ms: p.ping_ms,
                score: p.score,
            })
            .collect();
        let creatures: Vec<CreatureState> = self
            .creatures
            .iter()
            .map(|c| CreatureState {
                id: c.id,
                kind: c.kind.slug().to_string(),
                x: c.pos[0],
                y: c.pos[1],
                z: c.pos[2],
                yaw: c.yaw,
                hp: c.hp,
                max_hp: c.max_hp,
            })
            .collect();
        let snap = ServerMsg::Snapshot {
            tick: self.tick,
            players: states,
            creatures,
        };
        self.broadcast(&snap);

        self.publish_stats(now);

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
        tokio::task::spawn_blocking(move || {
            if let Err(e) = crate::persistence::save(&tenant, &blob) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::hub::Hub;
    use std::sync::Arc;

    /// A room wired to a fresh memory-db hub. The command receiver is owned by the room; tests drive
    /// it by calling its handlers directly rather than through the channel.
    async fn test_room() -> Room {
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

        room.on_admin_setting(1, ClientMsg::AdminSetPeace { on: true });
        assert!(room.peace);
        assert_eq!(drain_room_state(&mut admin_rx), Some((true, vec![])));
        assert_eq!(drain_room_state(&mut other_rx), Some((true, vec![])));
    }

    #[tokio::test]
    async fn non_admin_peace_is_ignored() {
        let mut room = test_room().await;
        let mut other_rx = add_player(&mut room, 2, false);

        room.on_admin_setting(2, ClientMsg::AdminSetPeace { on: true });
        assert!(!room.peace);
        assert_eq!(drain_room_state(&mut other_rx), None);
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
            Some((false, vec!["trophy".to_string()]))
        );

        room.on_admin_setting(
            1,
            ClientMsg::AdminSetStructure {
                kind: "trophy".into(),
                allowed: true,
            },
        );
        assert!(room.blocked_structures.is_empty());
        assert_eq!(drain_room_state(&mut admin_rx), Some((false, vec![])));
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

        room.on_admin_setting(1, ClientMsg::AdminSetPeace { on: false });
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
        // Point the ban store at a throwaway file so the test never writes the real bans list.
        let mut bans_file = std::env::temp_dir();
        bans_file.push(format!("room-ban-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&bans_file);
        std::env::set_var("BANS_FILE", &bans_file);

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

        std::env::remove_var("BANS_FILE");
        let _ = std::fs::remove_file(&bans_file);
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
}
