//! One authoritative room per (tenant, world). Runs a fixed-rate tick, owns the world
//! state, validates every client input, and broadcasts snapshots. The server is the
//! single source of truth; clients predict locally and reconcile from snapshots.

use std::collections::{BTreeSet, HashMap};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{
    BanEntry, Brand, ClientMsg, CreatureState, EditCell, EditOp, HeartDropState, InventoryItem,
    PlayerId, PlayerMeta, PlayerState, ServerMsg,
};
use rand::Rng;
use sim::World;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::creatures::{separate_creatures, Creature, CreatureKind};
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
// A defeated creature drops a heart pickup at its position: a player within PICKUP_RADIUS of it who is
// below MAX_HP collects it for +1 hp. Drops expire after HEART_TTL so they never accumulate. Mirrors the
// web rules (HEART_PICKUP_RADIUS, HEART_DROP_TTL_MS) so healing is identical online and offline.
const PICKUP_RADIUS: f32 = 1.4;
const HEART_TTL: Duration = Duration::from_millis(20_000);
// Horizontal bite reach: only a creature essentially touching the player bites. Kept just above the
// chaser's stop/orbit distance (creatures::STOP_DISTANCE) so a creature pressed up against — or circling
// — the player still lands the bite, but one ~1.5 blocks out does not. Mirrors the web HIT_RANGE.
const HURT_RANGE: f32 = 0.9;
// How far above/below the player's feet a creature can be and still bite. Symmetric + generous to match
// the offline rule (HIT_VERTICAL_GAP on the web): a ground creature whose center sits ~1 block below the
// feet of a player standing on top of a surface block must still be hit — do not regress that to a tight
// bound, or "the monsters aren't at the right height to attack" returns.
const HURT_VERTICAL_GAP: f32 = 1.3;
const PLAYER_EYE_HEIGHT: f32 = 1.55;
// Taps on the same block before the server breaks it — digging takes a little effort, enforced server-side.
const DIG_HITS: u8 = 2;
// Minimum gap between two accepted primary actions (dig / creature hit / pvp attack) from one player.
// The client holds-to-attack at ATTACK_REPEAT_MS (250ms); this is kept a touch more lenient to tolerate
// network jitter, so a modified client can't spam faster than a legit hold.
const ATTACK_MIN_INTERVAL: Duration = Duration::from_millis(200);

/// Cosmetic look a player picks before joining (validated server-side, broadcast to everyone).
pub struct Appearance {
    pub skin: String,
    pub shirt: String,
    pub hair: String,
}

/// What a connection's writer task receives. A fan-out message (snapshot, event, roster, …) is
/// serialized to JSON ONCE by the room and shared as a `Frame` across every player, so the per-tick
/// snapshot is encoded once for the whole room instead of once per connection. A per-player message
/// (welcome, inventory, error, …) travels as `One` and is serialized by the writer task that owns it.
pub enum Outbound {
    One(ServerMsg),
    Frame(Arc<str>),
}

/// Send one per-player message to a connection, dropping it if the channel is full or closed (a slow
/// client never stalls the room tick). Mirrors the old `let _ = conn.try_send(msg)` at every call site.
trait SendOne {
    fn send_one(&self, msg: ServerMsg);
}

impl SendOne for mpsc::Sender<Outbound> {
    fn send_one(&self, msg: ServerMsg) {
        let _ = self.try_send(Outbound::One(msg));
    }
}

pub enum RoomCmd {
    Join {
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<Outbound>,
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
    conn: mpsc::Sender<Outbound>,
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
    // When this player's last primary action (dig / creature hit / pvp attack) was accepted, used to
    // throttle a too-fast client to the hold cadence (ATTACK_MIN_INTERVAL).
    last_action: Instant,
    // Play-time accounting key: the account id for a logged-in player, else `ip:<addr>` so an
    // anonymous guest's budget tracks by address. Together with the baseline (used time before this
    // session) and the persisted delta (so the periodic flush only writes the new time).
    playtime_key: String,
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
    // Heart pickups dropped by defeated creatures, plus the monotonic id counter that names each one. A
    // player within PICKUP_RADIUS below MAX_HP collects one for +1 hp; drops also expire after HEART_TTL.
    heart_drops: Vec<HeartDrop>,
    next_heart_drop_id: u32,
    // Per-tenant play-time budget, cached from the db (refreshed on join, written through on the admin
    // toggle; 0 = unlimited). A player (logged-in or anonymous) that exceeds `playtime_limit_ms` within
    // `playtime_window_ms` is sent to the lobby. The raw minutes/hours are kept to echo on RoomState.
    playtime_limit_ms: i64,
    playtime_window_ms: i64,
    playtime_limit_min: u32,
    playtime_window_h: u32,
    // Per-tenant moderation flags + allowed game modes, cached from the `tenants` row (refreshed on
    // join, written through on toggle). This room is the only writer for its tenant, so the cache is
    // authoritative at runtime.
    suspended: bool,
    approval_required: bool,
    online_allowed: bool,
    offline_allowed: bool,
}

/// A heart pickup on the ground, dropped where a creature died. Collected by a damaged player who walks
/// within PICKUP_RADIUS of it (for +1 hp), or removed once it has been alive longer than HEART_TTL.
struct HeartDrop {
    id: u32,
    pos: [f32; 3],
    spawned_at: Instant,
}

/// The server build identifier shown in the in-game debug panel — kept the SAME TYPE as the frontend's
/// (a short git SHA): the deploy's `GIT_SHA` env when set, else the SHA baked at build time (build.rs),
/// else the crate version as a last resort.
fn server_version() -> String {
    resolve_server_version(
        std::env::var("GIT_SHA").ok().as_deref(),
        option_env!("BUILD_GIT_SHA"),
        env!("CARGO_PKG_VERSION"),
    )
}

fn resolve_server_version(
    git_sha_env: Option<&str>,
    build_sha: Option<&str>,
    crate_version: &str,
) -> String {
    if let Some(sha) = git_sha_env.filter(|s| !s.is_empty()) {
        return sha.to_string();
    }
    if let Some(sha) = build_sha.filter(|s| !s.is_empty()) {
        return sha.to_string();
    }
    crate_version.to_string()
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
            heart_drops: Vec::new(),
            next_heart_drop_id: 1,
            playtime_limit_ms: 0,
            playtime_window_ms: 0,
            playtime_limit_min: 0,
            playtime_window_h: 0,
            suspended: false,
            approval_required: false,
            online_allowed: true,
            offline_allowed: true,
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
        conn: mpsc::Sender<Outbound>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        // The ban is enforced in `admit`, after the claim resolves to a role, so a banned admin/moderator
        // is still admitted; only the role is unknown here.
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
        conn: mpsc::Sender<Outbound>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        // Role-aware ban gate: a banned IP is turned away here (the claim has resolved to a role) UNLESS
        // the account is an admin or moderator — they must still get in to moderate, even from a shared
        // home IP that someone got banned on. A banned guest/ordinary player stays refused.
        if self.hub.bans.is_banned(ip) && !role.is_admin() && !role.is_moderator() {
            let _ = reply.send(Err("banned".into()));
            return;
        }
        // Refresh the per-tenant moderation flags + allowed modes from the db (this room is the single
        // writer, so the cache stays authoritative between joins).
        let (suspended, approval_required) = self
            .hub
            .db
            .tenant_flags(&self.key.0)
            .await
            .unwrap_or((false, false));
        self.suspended = suspended;
        self.approval_required = approval_required;
        let (online_allowed, offline_allowed) = self
            .hub
            .db
            .tenant_modes(&self.key.0)
            .await
            .unwrap_or((true, true));
        self.online_allowed = online_allowed;
        self.offline_allowed = offline_allowed;
        // Peace (monsters calm) is persisted so an admin who turned monsters ON keeps them on across a
        // room restart, instead of silently resetting to calm and looking like "monsters deal no damage".
        self.peace = self.hub.db.tenant_peace(&self.key.0).await.unwrap_or(true);
        // Online play disabled for this tenant: reject the join (offline reaches the client only, gated
        // there). Admins still get in so they can re-enable it from the in-game panel. The reject reason
        // travels as the reply code; conn.rs turns it into the user-facing message (reject_message).
        if !self.online_allowed && !role.is_admin() {
            let _ = reply.send(Err("online_blocked".into()));
            return;
        }
        // A suspended world turns everyone away except admins, who still need to get in to resume it.
        if self.suspended && !role.is_admin() {
            let _ = reply.send(Err("suspended".into()));
            return;
        }
        // Approval gate (per-tenant, off by default): while on, admins always get in (to manage), and
        // everyone else — including anonymous guests, who do NOT have to log in — is held for approval.
        // The held player is keyed by account id, or by IP for a guest (same as playtime), recorded as
        // pending so the admins are notified; they approve in-game (and by email when there is one).
        if self.approval_required && !role.is_admin() {
            let approval_key = playtime_key(&account_id, ip);
            // A reject is one-shot (expel, not ban): tell this attempt "rejected" and clear the request,
            // so a fresh join falls through to hold_for_approval below and the admins are re-notified.
            if self
                .hub
                .db
                .is_rejected(&self.key.0, &approval_key)
                .await
                .unwrap_or(false)
            {
                if let Err(e) = self
                    .hub
                    .db
                    .clear_approval_request(&self.key.0, &approval_key)
                    .await
                {
                    tracing::error!(error = %e, "clearing one-shot reject failed");
                }
                let _ = reply.send(Err("rejected".into()));
                return;
            }
            if !self
                .hub
                .db
                .is_approved(&self.key.0, &approval_key)
                .await
                .unwrap_or(false)
            {
                let display_name = if authoritative_name.is_empty() {
                    "Guest"
                } else {
                    &authoritative_name
                };
                self.hold_for_approval(&approval_key, display_name).await;
                let _ = reply.send(Err("needs_approval".into()));
                return;
            }
        }
        // Play-time budget (per-tenant): cache the tenant's config and turn an over-budget player away
        // with "time_up". A logged-in player is keyed by account; an anonymous guest by their IP, so
        // their budget still accrues (in the same `playtime` table) across guest sessions.
        let (limit_min, window_h) = self
            .hub
            .db
            .tenant_playtime(&self.key.0)
            .await
            .unwrap_or((0, 0));
        self.playtime_limit_min = limit_min as u32;
        self.playtime_window_h = window_h as u32;
        self.playtime_limit_ms = limit_min * 60_000;
        self.playtime_window_ms = window_h * 3_600_000;
        let playtime_key = playtime_key(&account_id, ip);
        let mut playtime_baseline = 0;
        if self.playtime_limit_ms > 0 {
            playtime_baseline = self
                .hub
                .db
                .playtime_used(
                    &self.key.0,
                    &playtime_key,
                    self.playtime_window_ms,
                    epoch_ms() as i64,
                )
                .await
                .unwrap_or(0);
            if playtime_baseline >= self.playtime_limit_ms {
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
        let spawn = self.spawn_slot(None);
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
            last_action: now - ATTACK_MIN_INTERVAL,
            playtime_key,
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
        conn.send_one(welcome);
        // Hand the joining player the world that has already been built.
        let edits: Vec<EditCell> = self
            .world
            .snapshot()
            .into_iter()
            .map(|(x, y, z, block)| EditCell { x, y, z, id: block })
            .collect();
        for chunk in edits.chunks(BATCH_CHUNK_SIZE) {
            conn.send_one(ServerMsg::EditBatch {
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
                    // The player-report feature was removed; skip any legacy `report|` rows still on the
                    // timeline so they never replay (their feed string no longer exists).
                    let is_legacy_report =
                        event.kind == "admin" && event.detail.starts_with("report|");
                    if is_legacy_report {
                        continue;
                    }
                    conn.send_one(ServerMsg::Event {
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
        conn.send_one(self.room_state());
        // An admin also gets the current pending-approval list + ban list so they can manage right away.
        if role.is_admin() {
            send_pending(&self.hub.db, &self.key.0, std::slice::from_ref(&conn)).await;
            conn.send_one(self.bans_msg());
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
        if let ClientMsg::AdminReject { account_id } = msg {
            self.on_admin_reject(id, account_id);
            return;
        }
        if let ClientMsg::AdminBanPending { account_id } = msg {
            self.on_admin_ban_pending(id, account_id);
            return;
        }
        if let ClientMsg::AdminUnban { ip } = msg {
            self.on_admin_unban(id, ip);
            return;
        }

        // Play-time + mode limits write the tenant row and re-cache, so they own the handler.
        if let ClientMsg::AdminSetLimits {
            playtime_limit_min,
            playtime_window_h,
        } = msg
        {
            self.on_admin_set_limits(id, playtime_limit_min, playtime_window_h);
            return;
        }
        if let ClientMsg::AdminSetModes {
            online_allowed,
            offline_allowed,
        } = msg
        {
            self.on_admin_set_modes(id, online_allowed, offline_allowed);
            return;
        }

        // A PvP attack reads both the attacker and the target, so it is handled before the single
        // borrow below as well.
        if let ClientMsg::AttackPlayer { id: target } = msg {
            if let Some(p) = self.players.get_mut(&id) {
                p.last_seen = now;
            }
            if !self.accept_primary_action(id, now) {
                return;
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
            if !self.accept_primary_action(id, now) {
                return;
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
            if !self.accept_primary_action(id, now) {
                return;
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
                if !in_world || !finite {
                    tracing::debug!(id = %id, "move rejected: out of bounds / non-finite");
                }
                if in_world && finite {
                    // A normal in-budget move (or the first sync) is taken whole. An over-budget move is
                    // NOT dropped — dropping strands a desynced player at a stale position forever, since
                    // every later move is then "too far" too (a deadlock that freezes them in place and
                    // makes them invisible/wrong to everyone else). Instead step toward the reported
                    // position at the speed cap so the server converges to the client within a few ticks,
                    // which still caps real speed (the anti-cheat intent).
                    let first_sync = !p.move_synced;
                    p.move_synced = true;
                    p.yaw = yaw;
                    p.pitch = pitch;
                    let factor = if dist <= allowed || first_sync || dist == 0.0 {
                        1.0
                    } else {
                        allowed / dist
                    };
                    p.x += dx * factor;
                    p.y += dy * factor;
                    p.z += dz * factor;
                    if factor < 1.0 {
                        tracing::debug!(id = %id, dist, allowed, "move clamped toward client (converging)");
                    }
                }
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
                if !crate::chat::is_allowed(&text) {
                    tracing::debug!(%id, "chat message blocked by moderation filter");
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
            | ClientMsg::AdminReject { .. }
            | ClientMsg::AdminBanPending { .. }
            | ClientMsg::AdminUnban { .. }
            | ClientMsg::AdminSetLimits { .. }
            | ClientMsg::AdminSetModes { .. }
            | ClientMsg::AttackPlayer { .. }
            | ClientMsg::Hit { .. }
            | ClientMsg::Respawn
            | ClientMsg::Dig { .. } => { /* handled before the per-player borrow above */ }
            ClientMsg::Join { .. } => { /* handled at connect, not per-input */ }
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
            self.lift_stuck_players();
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
            self.lift_stuck_players();
        }
        if let Some(m) = chat_out {
            if let ServerMsg::Chat { name, text, .. } = &m {
                let db = self.hub.db.clone();
                let tenant = self.key.0.clone();
                let name = name.clone();
                let text = text.clone();
                tokio::spawn(async move {
                    if let Err(e) = db.record_chat(&tenant, &name, &text).await {
                        tracing::error!(error = %e, "failed to persist chat");
                    }
                });
            }
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
        p.conn.send_one(ServerMsg::Inventory {
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
                if changed {
                    let db = self.hub.db.clone();
                    let tenant = self.key.0.clone();
                    tokio::spawn(async move {
                        if let Err(e) = db.set_tenant_peace(&tenant, on).await {
                            tracing::error!(error = %e, "set_tenant_peace failed");
                        }
                    });
                }
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
        // A moderator (kid) may kick, but only an admin (parent) may ban.
        let may_act = if ban {
            admin.is_admin
        } else {
            admin.is_admin || admin.is_moderator
        };
        if !may_act {
            tracing::debug!(%admin_id, ban, "remove ignored: insufficient authority");
            return;
        }
        let admin_name = admin.name.clone();
        let Some(target) = self.players.get(&target_id) else {
            return;
        };
        // An admin or moderator can never be banned (a kick still works): banning staff is refused so a
        // ban can't lock a fellow grown-up/helper out of the world.
        if ban && (target.is_admin || target.is_moderator) {
            tracing::debug!(%admin_id, %target_id, "ban ignored: target is an admin/moderator");
            return;
        }
        let target_ip = target.ip;
        let target_name = target.name.clone();
        let (code, message) = if ban {
            ("banned", "Your access has been revoked.")
        } else {
            ("kicked", "You were removed from the room by an admin.")
        };
        target.conn.send_one(ServerMsg::Error {
            code: code.into(),
            msg: message.into(),
        });
        if ban {
            self.hub.bans.ban(target_ip, target_name.clone());
            self.broadcast_bans_to_admins();
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
        self.heart_drops.clear();
        self.dirty = true;
        self.flush();
        // A world reset is a fresh start for everyone: wipe every player's progress (score/leaderboard)
        // and reset their live combat state — full hearts and an emptied banked inventory — so no metric
        // survives the blocks. The zeroed score/hp ride the next slim Snapshot; inventories are resent now.
        self.wipe_all_scores();
        let ids: Vec<PlayerId> = self.players.keys().copied().collect();
        for player_id in &ids {
            let Some(p) = self.players.get_mut(player_id) else {
                continue;
            };
            p.hp = MAX_HP;
            p.inventory.clear();
        }
        for player_id in &ids {
            self.send_inventory(*player_id);
        }
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
        self.wipe_all_scores();
        self.broadcast(&ServerMsg::Event {
            kind: "reset_scores".into(),
            name: admin_name,
            detail: String::new(),
        });
        tracing::info!(tenant = %self.key.0, %id, "scores reset by admin");
    }

    /// Zero every live player's score and clear the tenant's persisted leaderboard. Shared by the
    /// standalone "reset scores" action and the full world reset; callers do their own admin gating.
    fn wipe_all_scores(&mut self) {
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
                    p.conn.send_one(ServerMsg::Error {
                        code: "suspended".into(),
                        msg: "This world is paused by an admin.".into(),
                    });
                }
                self.broadcast(&ServerMsg::Left { id: pid });
            }
        }
        tracing::info!(tenant = %self.key.0, %id, on, "world suspension set by admin");
    }

    /// Change an online player's role. Admin-only (parents); moderators (kids) may never grant a role
    /// (their reach is at most a kick). The change takes effect live (the target's flags + a Role
    /// message) and is persisted to the account.
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
        let actor_name = actor.name.clone();
        // Only admins (parents) change roles. Moderators (kids) may at most kick — never grant a role.
        if !actor_is_admin {
            tracing::debug!(%actor_id, "set-role ignored: only admins change roles");
            return;
        }
        let Some(target) = self.players.get_mut(&target_id) else {
            return;
        };
        target.is_admin = role.is_admin();
        target.is_moderator = role.is_moderator();
        let target_account = target.account_id.clone();
        let target_name = target.name.clone();
        target.conn.send_one(ServerMsg::Role {
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

    /// Record a held-out player (a logged-in account, or a guest keyed by IP) as pending, email the
    /// tenant's admins, and refresh the in-game pending list for any online admin so they can approve
    /// immediately. A guest has no account, so the request carries an empty email (admins are still
    /// notified in-game + by the tenant-admin email).
    async fn hold_for_approval(&mut self, account_id: &str, name: &str) {
        let email = match self.hub.db.get_account_by_id(account_id).await {
            Ok(Some(account)) => account.email,
            Ok(None) => String::new(),
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
        let admin_conns: Vec<mpsc::Sender<Outbound>> = self
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

    /// Set the per-tenant play-time budget. Admin-only; re-caches the live limit so the running tick
    /// loop enforces it at once (and re-baselines current players so a freshly set limit counts their
    /// stored usage), persists the tenant row, and broadcasts the new RoomState.
    fn on_admin_set_limits(&mut self, id: PlayerId, limit_min: u32, window_h: u32) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "limits ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        if self.playtime_limit_min == limit_min && self.playtime_window_h == window_h {
            return;
        }
        self.playtime_limit_min = limit_min;
        self.playtime_window_h = window_h;
        self.playtime_limit_ms = limit_min as i64 * 60_000;
        self.playtime_window_ms = window_h as i64 * 3_600_000;
        let db = self.hub.db.clone();
        let tenant = self.key.0.clone();
        tokio::spawn(async move {
            if let Err(e) = db.set_tenant_playtime(&tenant, limit_min, window_h).await {
                tracing::error!(error = %e, "set_tenant_playtime failed");
            }
        });
        let state = self.room_state();
        self.broadcast(&state);
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("limits|{limit_min}|{window_h}"),
        });
        tracing::info!(tenant = %self.key.0, %id, limit_min, window_h, "play-time budget set by admin");
    }

    /// Set the per-tenant allowed game modes. Admin-only; a toggle that would disable BOTH modes is
    /// ignored (a tenant always keeps at least one). Persists the tenant row + broadcasts RoomState.
    fn on_admin_set_modes(&mut self, id: PlayerId, online_allowed: bool, offline_allowed: bool) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "modes ignored: not an admin");
            return;
        }
        if !online_allowed && !offline_allowed {
            tracing::debug!(%id, "modes ignored: cannot disable the last mode");
            return;
        }
        let admin_name = admin.name.clone();
        if self.online_allowed == online_allowed && self.offline_allowed == offline_allowed {
            return;
        }
        self.online_allowed = online_allowed;
        self.offline_allowed = offline_allowed;
        let db = self.hub.db.clone();
        let tenant = self.key.0.clone();
        tokio::spawn(async move {
            if let Err(e) = db
                .set_tenant_modes(&tenant, online_allowed, offline_allowed)
                .await
            {
                tracing::error!(error = %e, "set_tenant_modes failed");
            }
        });
        let state = self.room_state();
        self.broadcast(&state);
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("modes|{online_allowed}|{offline_allowed}"),
        });
        // Turning online play off sends everyone but the admin who did it to the lobby (they manage from
        // there); the gate in `admit` keeps new online joins out until it's re-enabled.
        if !online_allowed {
            let ids: Vec<PlayerId> = self.players.keys().copied().filter(|&p| p != id).collect();
            for pid in ids {
                if let Some(p) = self.players.remove(&pid) {
                    p.conn.send_one(ServerMsg::Error {
                        code: "online_blocked".into(),
                        msg: "Online play is turned off for this world.".into(),
                    });
                }
                self.broadcast(&ServerMsg::Left { id: pid });
            }
        }
        tracing::info!(tenant = %self.key.0, %id, online_allowed, offline_allowed, "modes set by admin");
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
        let admin_conns: Vec<mpsc::Sender<Outbound>> = self
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

    /// Reject a pending account. Admin-only; the request is marked rejected (the held player's next join
    /// is turned away with "rejected") and the pending list is refreshed for online admins.
    fn on_admin_reject(&mut self, id: PlayerId, account_id: String) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "reject ignored: not an admin");
            return;
        }
        let admin_name = admin.name.clone();
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("reject|{account_id}"),
        });
        let tenant = self.key.0.clone();
        let admin_conns: Vec<mpsc::Sender<Outbound>> = self
            .players
            .values()
            .filter(|p| p.is_admin)
            .map(|p| p.conn.clone())
            .collect();
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

    /// Permanently ban a player still waiting for approval. Admin-only; the approval key carries the
    /// guest's address (`ip:<addr>`), so the ban is applied to that IP (reusing the existing ban path),
    /// the pending request is dropped, and the pending + ban lists are refreshed for online admins.
    fn on_admin_ban_pending(&mut self, id: PlayerId, account_id: String) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "ban pending ignored: not an admin");
            return;
        }
        let Some(addr) = account_id.strip_prefix("ip:") else {
            // The key is a real account id (a logged-in held player), not a guest's `ip:<addr>`. Banning
            // here only ever targets guests by IP; an account-keyed entry — the only way a target could
            // resolve to an admin/moderator — is never banned through this path, so staff stay safe.
            tracing::debug!(%id, key = %account_id, "ban pending ignored: key carries no ip");
            return;
        };
        let Ok(ip) = addr.parse::<IpAddr>() else {
            tracing::debug!(%id, key = %account_id, "ban pending ignored: unparsable ip");
            return;
        };
        let admin_name = admin.name.clone();
        self.hub.bans.ban(ip, account_id.clone());
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("ban|{account_id}"),
        });
        self.broadcast_bans_to_admins();
        let tenant = self.key.0.clone();
        let admin_conns: Vec<mpsc::Sender<Outbound>> = self
            .players
            .values()
            .filter(|p| p.is_admin)
            .map(|p| p.conn.clone())
            .collect();
        let db = self.hub.db.clone();
        tokio::spawn(async move {
            if let Err(e) = db.clear_approval_request(&tenant, &account_id).await {
                tracing::error!(error = %e, "ban pending: clearing request failed");
                return;
            }
            tracing::info!(%tenant, %ip, "pending player banned by admin");
            send_pending(&db, &tenant, &admin_conns).await;
        });
    }

    /// Lift a global IP ban. Admin-only; updates the live + persisted ban list and refreshes the ban
    /// list shown to online admins.
    fn on_admin_unban(&mut self, id: PlayerId, ip: String) {
        let Some(admin) = self.players.get_mut(&id) else {
            return;
        };
        admin.last_seen = Instant::now();
        if !admin.is_admin {
            tracing::debug!(%id, "unban ignored: not an admin");
            return;
        }
        let Ok(parsed) = ip.parse::<IpAddr>() else {
            return;
        };
        if !self.hub.bans.unban(parsed) {
            return;
        }
        let admin_name = admin.name.clone();
        self.broadcast(&ServerMsg::Event {
            kind: "admin".into(),
            name: admin_name,
            detail: format!("unban|{ip}"),
        });
        self.broadcast_bans_to_admins();
    }

    fn bans_msg(&self) -> ServerMsg {
        ServerMsg::Bans {
            bans: self
                .hub
                .bans
                .list_named()
                .into_iter()
                .map(|(ip, name)| BanEntry { ip, name })
                .collect(),
        }
    }

    fn broadcast_bans_to_admins(&self) {
        let msg = self.bans_msg();
        for p in self.players.values().filter(|p| p.is_admin) {
            p.conn.send_one(msg.clone());
        }
    }

    /// Push the current pending-approval list to every online admin (no-op if none are online).
    async fn broadcast_pending_to_admins(&self) {
        let admin_conns: Vec<mpsc::Sender<Outbound>> = self
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
    /// Accept a primary action (dig / creature hit / pvp attack) only if enough time has passed since
    /// this player's last accepted one, throttling a modified client to the legit hold cadence.
    fn accept_primary_action(&mut self, id: PlayerId, now: Instant) -> bool {
        let Some(p) = self.players.get_mut(&id) else {
            return false;
        };
        if now.duration_since(p.last_action) < ATTACK_MIN_INTERVAL {
            return false;
        }
        p.last_action = now;
        // Every accepted primary action (dig tap / creature hit / pvp attack) swings the actor's avatar
        // arm for everyone else; the actor already swung their own first-person view locally. Purely
        // cosmetic — no gameplay change.
        self.broadcast_except(id, &ServerMsg::Swing { id });
        true
    }

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
        target.conn.send_one(ServerMsg::Hurt { by: attacker_name });
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
            playtime_limit_min: self.playtime_limit_min,
            playtime_window_h: self.playtime_window_h,
            online_allowed: self.online_allowed,
            offline_allowed: self.offline_allowed,
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
                // An admin/moderator is exempt from the ban (same rule as the join gate): a ban on their
                // shared IP must never expel them mid-session, or they couldn't moderate.
                if self.hub.bans.is_banned(p.ip) && !p.is_admin && !p.is_moderator {
                    p.conn.send_one(ServerMsg::Error {
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
                    p.conn.send_one(ServerMsg::Error {
                        code: "reclaimed".into(),
                        msg: "Your username was taken over from another device.".into(),
                    });
                    tracing::debug!(id = %p.id, account_id = %p.account_id, "reclaimed kick");
                    kicked.push(p.id);
                    continue;
                }
                if now.duration_since(p.last_seen) > idle {
                    p.conn.send_one(ServerMsg::Error {
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

            // Play-time accounting: flush each player's session delta to the db (keyed by account or
            // IP, so anonymous guests accrue too) and send the ones who hit their budget to the lobby.
            if self.playtime_limit_ms > 0 {
                let limit = self.playtime_limit_ms;
                let window = self.playtime_window_ms;
                let now_ms = epoch_ms() as i64;
                let tenant = self.key.0.clone();
                let mut time_up: Vec<PlayerId> = Vec::new();
                for p in self.players.values_mut() {
                    let session = now_ms - p.joined_at_ms as i64;
                    let delta = session - p.playtime_persisted_ms;
                    if delta > 0 {
                        p.playtime_persisted_ms = session;
                        let db = self.hub.db.clone();
                        let tenant = tenant.clone();
                        let key = p.playtime_key.clone();
                        tokio::spawn(async move {
                            if let Err(e) =
                                db.add_playtime(&tenant, &key, delta, window, now_ms).await
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
                        p.conn.send_one(ServerMsg::Error {
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
                p.conn.send_one(ServerMsg::Ping {
                    nonce: p.ping_nonce,
                });
            }
        }

        // Maintain and advance the creature population, then resolve heart pickups, before snapshotting.
        self.simulate_creatures(dt);
        self.collect_hearts();

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
        let hearts: Vec<HeartDropState> = self
            .heart_drops
            .iter()
            .map(|h| {
                HeartDropState(
                    h.id,
                    round_snapshot(h.pos[0]),
                    round_snapshot(h.pos[1]),
                    round_snapshot(h.pos[2]),
                )
            })
            .collect();
        let snap = ServerMsg::Snapshot {
            tick: self.tick,
            players: states,
            creatures,
            hearts,
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

    /// Fan a message out to every player. The message is serialized to JSON ONCE here and the resulting
    /// frame is shared (an `Arc<str>`) across all connections, so the hot per-tick snapshot is encoded a
    /// single time for the whole room instead of once per writer task — the dominant cost as the
    /// creature + player counts grow. A serialization error drops the frame (it never happens for our
    /// wire types). `try_send` is non-blocking, so a slow client's full channel never stalls the tick.
    fn broadcast(&self, msg: &ServerMsg) {
        let Some(frame) = serialize_frame(msg) else {
            return;
        };
        for p in self.players.values() {
            let _ = p.conn.try_send(Outbound::Frame(frame.clone()));
        }
    }

    /// Broadcast to everyone except one player (e.g. the attacker, who already played the hit effect
    /// locally for instant feedback — the others see it via this). Single-serialized like `broadcast`.
    fn broadcast_except(&self, except: PlayerId, msg: &ServerMsg) {
        let Some(frame) = serialize_frame(msg) else {
            return;
        };
        for p in self.players.values() {
            if p.id == except {
                continue;
            }
            let _ = p.conn.try_send(Outbound::Frame(frame.clone()));
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
        // Hard ceiling on the live population, enforced every tick so the O(n²) separation pass and the
        // per-player bite check stay cheap: with many players the union of their despawn radii can keep
        // more than MAX_CREATURES alive, so any excess is trimmed, dropping the ones farthest from every
        // player first. Without this cap a crowded room accumulated creatures until the tick fell behind
        // and ping spiralled.
        cap_creatures(&mut self.creatures, &player_xz, MAX_CREATURES);
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
        // Spread out any creatures that ended the step stacked so they never overlap into one blob; the
        // pass re-settles each onto its ground column, keeping them out of solid terrain.
        separate_creatures(&mut self.creatures, |x, z| world.surface_y(x, z));
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
                    && (c[1] - feet).abs() < HURT_VERTICAL_GAP
            });
            if !bitten {
                continue;
            }
            p.hp = p.hp.saturating_sub(1);
            p.hurt_at = now;
            p.conn.send_one(ServerMsg::Hurt { by: String::new() });
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
    /// A fresh random base within the spawn area (so players land scattered, not stacked on the centre)
    /// nudged to the nearest clear column over the live world, creatures and players, so a player never
    /// materialises inside terrain/the monument/built blocks or on top of a monster or another player.
    /// `exclude` drops one player (the respawning one) from the occupancy check so they don't block
    /// their own slot. The returned y is the eye position (feet + PLAYER_EYE_HEIGHT).
    fn spawn_slot(&self, exclude: Option<PlayerId>) -> [f32; 3] {
        let mut actors: Vec<[f32; 2]> = self
            .creatures
            .iter()
            .map(|c| [c.pos[0], c.pos[2]])
            .collect();
        actors.extend(
            self.players
                .values()
                .filter(|p| Some(p.id) != exclude)
                .map(|p| [p.x, p.z]),
        );
        let mut rng = rand::thread_rng();
        let (base_x, base_z) = sim::random_spawn_base(rng.gen(), rng.gen());
        let (x, z) = sim::find_spawn_slot(base_x, base_z, sim::SPAWN_SEARCH_RADIUS, |x, z| {
            sim::spawn_column_clear(x, z, sim::SPAWN_CLEARANCE_GAP, &self.world, &actors)
        });
        let mut feet = self.world.surface_y(x, z) + 1;
        while feet < sim::SIZE_Y - 2
            && (self.world.is_solid(x, feet, z) || self.world.is_solid(x, feet + 1, z))
        {
            feet += 1;
        }
        [
            x as f32 + 0.5,
            feet as f32 + PLAYER_EYE_HEIGHT,
            z as f32 + 0.5,
        ]
    }

    fn respawn(&mut self, id: PlayerId) {
        let spawn = self.spawn_slot(Some(id));
        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.x = spawn[0];
        p.y = spawn[1];
        p.z = spawn[2];
        p.hp = MAX_HP;
        p.hurt_at = Instant::now();
        p.move_synced = false;
        p.conn.send_one(ServerMsg::Respawn {
            x: spawn[0],
            y: spawn[1],
            z: spawn[2],
            hp: MAX_HP,
        });
    }

    /// After an edit makes a column solid, free any player whose feet or head cell just turned solid:
    /// raise their feet until the two-cell body column is clear (mirrors the client's `clearFeetAbove`),
    /// re-baseline the anti-cheat so the snap is accepted, and tell that player to reposition (everyone
    /// else sees the corrected position in the next Snapshot). A buggy client that never self-unsticks is
    /// still freed because this is server-authoritative.
    fn lift_stuck_players(&mut self) {
        let lifts: Vec<(PlayerId, f32)> = self
            .players
            .values()
            .filter_map(|p| {
                let fx = p.x.floor() as i32;
                let fz = p.z.floor() as i32;
                let feet = (p.y - PLAYER_EYE_HEIGHT).floor() as i32;
                if !self.world.is_solid(fx, feet, fz) && !self.world.is_solid(fx, feet + 1, fz) {
                    return None;
                }
                let mut clear = feet;
                while clear < sim::SIZE_Y - 2
                    && (self.world.is_solid(fx, clear, fz)
                        || self.world.is_solid(fx, clear + 1, fz))
                {
                    clear += 1;
                }
                Some((p.id, clear as f32 + PLAYER_EYE_HEIGHT))
            })
            .collect();
        for (id, y) in lifts {
            let Some(p) = self.players.get_mut(&id) else {
                continue;
            };
            p.y = y;
            p.move_synced = false;
            p.conn.send_one(ServerMsg::Respawn {
                x: p.x,
                y,
                z: p.z,
                hp: p.hp,
            });
            tracing::debug!(id = %id, y, "lifted player out of a solid edit");
        }
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
        let death_pos = self.creatures[index].pos;
        self.creatures.remove(index);
        self.drop_heart(death_pos);
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

    /// Drop a heart pickup at a defeated creature's position, for a damaged player to collect.
    fn drop_heart(&mut self, pos: [f32; 3]) {
        let id = self.next_heart_drop_id;
        self.next_heart_drop_id = self.next_heart_drop_id.wrapping_add(1);
        self.heart_drops.push(HeartDrop {
            id,
            pos,
            spawned_at: Instant::now(),
        });
        tracing::debug!(tenant = %self.key.0, id, "heart dropped");
    }

    /// Each tick: a damaged player (hp < MAX_HP) within PICKUP_RADIUS of a drop collects it for +1 hp;
    /// the next Snapshot carries the new hp like every other health change. The drop is then consumed.
    /// Any drop older than HEART_TTL is removed so they never accumulate.
    fn collect_hearts(&mut self) {
        let now = Instant::now();
        let mut kept: Vec<HeartDrop> = Vec::with_capacity(self.heart_drops.len());
        for drop in std::mem::take(&mut self.heart_drops) {
            if now.duration_since(drop.spawned_at) > HEART_TTL {
                continue;
            }
            // A player standing on a drop picks it up regardless of health — it's collected (and gone)
            // even at full hp; it only heals when below the max.
            let taker = self
                .players
                .values_mut()
                .find(|p| distance(p.x, p.y - PLAYER_EYE_HEIGHT, p.z, drop.pos) <= PICKUP_RADIUS);
            let Some(taker) = taker else {
                kept.push(drop);
                continue;
            };
            if taker.hp < MAX_HP {
                taker.hp += 1;
            }
            tracing::debug!(tenant = %self.key.0, id = drop.id, player = %taker.id, hp = taker.hp, "heart collected");
        }
        self.heart_drops = kept;
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

// Cap on a structure-kind id (the web prebuilt ids are short slugs like "trophy", "hero").
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

/// Serialize a fan-out message to a shared JSON frame for the whole room (one encode, sent verbatim to
/// every connection). Returns `None` only if serialization fails, which never happens for our wire
/// types; the caller then drops the frame rather than sending malformed bytes.
fn serialize_frame(msg: &ServerMsg) -> Option<Arc<str>> {
    match serde_json::to_string(msg) {
        Ok(json) => Some(Arc::from(json.as_str())),
        Err(e) => {
            tracing::error!(error = %e, "failed to serialize broadcast frame");
            None
        }
    }
}

/// Round a snapshot coordinate to centimeter precision so the wire number stays short.
fn round_snapshot(value: f32) -> f32 {
    (value * SNAPSHOT_DECIMALS).round() / SNAPSHOT_DECIMALS
}

/// 3D distance from a point to a position, used to test whether a player reaches a heart drop.
fn distance(x: f32, y: f32, z: f32, pos: [f32; 3]) -> f32 {
    ((x - pos[0]).powi(2) + (y - pos[1]).powi(2) + (z - pos[2]).powi(2)).sqrt()
}

/// Trim the creature population down to `max`, dropping the creatures farthest from every player first
/// so the ones near players (the gameplay-relevant ones) are kept. A no-op when already within the cap.
/// This is the hard ceiling the spawn target also respects; enforcing it on the live vector guarantees
/// the count can never exceed `max` regardless of how many players' despawn radii overlap.
fn cap_creatures(creatures: &mut Vec<Creature>, players: &[[f32; 2]], max: usize) {
    if creatures.len() <= max {
        return;
    }
    creatures.sort_by(|a, b| {
        nearest_horizontal(a.pos, players).total_cmp(&nearest_horizontal(b.pos, players))
    });
    creatures.truncate(max);
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

/// The `playtime` table key for a player: their account id when logged in, else their IP (prefixed so
/// it can never collide with a real account id), so an anonymous guest's budget accrues by address.
fn playtime_key(account_id: &str, ip: IpAddr) -> String {
    if account_id.is_empty() {
        return format!("ip:{ip}");
    }
    account_id.to_string()
}

/// Load the tenant's pending-approval list and send it to each given (admin) connection.
async fn send_pending(db: &crate::db::Db, tenant: &str, conns: &[mpsc::Sender<Outbound>]) {
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
        conn.send_one(ServerMsg::PendingApprovals {
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

    #[test]
    fn server_version_prefers_env_then_baked_sha_then_crate() {
        assert_eq!(
            resolve_server_version(Some("abc1234"), Some("def5678"), "0.1.0"),
            "abc1234"
        );
        assert_eq!(
            resolve_server_version(None, Some("def5678"), "0.1.0"),
            "def5678"
        );
        assert_eq!(
            resolve_server_version(Some(""), Some("def5678"), "0.1.0"),
            "def5678"
        );
        assert_eq!(resolve_server_version(None, None, "0.1.0"), "0.1.0");
        assert_eq!(resolve_server_version(None, Some(""), "0.1.0"), "0.1.0");
    }

    /// A room wired to a fresh memory-db hub. The command receiver is owned by the room; tests drive
    /// it by calling its handlers directly rather than through the channel.
    async fn test_room() -> Room {
        // Each test gets a fresh in-memory db, so the per-tenant flags (suspended/approval) start off
        // with no cross-test leak — no file-backed-gate reset needed anymore.
        let db = Arc::new(Db::memory().await);
        let hub = Arc::new(Hub::load(db).await);
        let tcfg = hub.tenants.get("acme").unwrap().clone();
        let (_tx, rx) = mpsc::channel::<RoomCmd>(16);
        Room::new(hub, &tcfg, "main".into(), rx)
    }

    /// Decode whatever a connection received back into a `ServerMsg`: a per-player `One` is unwrapped
    /// directly; a fan-out `Frame` is parsed back from the single JSON the room serialized once, so the
    /// assertions below test the exact bytes that reach a real client.
    fn unwrap_msg(out: Outbound) -> ServerMsg {
        match out {
            Outbound::One(msg) => msg,
            Outbound::Frame(frame) => serde_json::from_str(&frame).expect("valid broadcast frame"),
        }
    }

    /// Receive the next message off a test connection as a decoded `ServerMsg` (see `unwrap_msg`), so the
    /// existing assertions keep matching on `ServerMsg` after the single-serialize broadcast change.
    trait RecvMsg {
        fn try_recv_msg(&mut self) -> Result<ServerMsg, mpsc::error::TryRecvError>;
    }

    impl RecvMsg for mpsc::Receiver<Outbound> {
        fn try_recv_msg(&mut self) -> Result<ServerMsg, mpsc::error::TryRecvError> {
            self.try_recv().map(unwrap_msg)
        }
    }

    /// Insert a minimal player into the room and return the channel that captures messages sent to it.
    fn add_player(room: &mut Room, id: PlayerId, is_admin: bool) -> mpsc::Receiver<Outbound> {
        let (conn, conn_rx) = mpsc::channel::<Outbound>(64);
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
            last_action: now - ATTACK_MIN_INTERVAL,
            playtime_key: format!("acc{id}"),
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

    fn drain_room_state(rx: &mut mpsc::Receiver<Outbound>) -> Option<(bool, Vec<String>)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv_msg() {
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
    fn drain_pvp_chat(rx: &mut mpsc::Receiver<Outbound>) -> Option<(bool, bool)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv_msg() {
            if let ServerMsg::RoomState {
                pvp, chat_enabled, ..
            } = msg
            {
                latest = Some((pvp, chat_enabled));
            }
        }
        latest
    }

    fn drain_left(rx: &mut mpsc::Receiver<Outbound>) -> Vec<PlayerId> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv_msg() {
            if let ServerMsg::Left { id } = msg {
                out.push(id);
            }
        }
        out
    }

    fn drain_hurt(rx: &mut mpsc::Receiver<Outbound>) -> Option<String> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv_msg() {
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
        let suspended = std::iter::from_fn(|| player_rx.try_recv_msg().ok())
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
        // Once synced, an impossibly fast jump is NOT taken whole — but it is NOT frozen either. The
        // server steps TOWARD the reported position at the speed cap so a desync can't strand the player
        // at a stale spot forever (which froze them / made them invisible to others). The position moves
        // partway and never teleports the full distance.
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
        let x = room.players.get(&1).unwrap().x;
        assert!(
            x > 50.0,
            "an over-budget move must converge toward the client, not freeze, got {x}"
        );
        assert!(
            x < 120.0,
            "an over-budget move must not teleport the full distance, got {x}"
        );
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
    async fn two_creatures_on_one_spot_separate_after_a_tick() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        room.peace = true;
        room.creatures.clear();
        room.creatures.push(Creature::spawn(
            80,
            CreatureKind::Pig,
            30.0,
            30.0,
            sim::height_at,
        ));
        room.creatures.push(Creature::spawn(
            81,
            CreatureKind::Pig,
            30.0,
            30.0,
            sim::height_at,
        ));
        room.simulate_creatures(0.05);
        let a = room.creatures[0].pos;
        let b = room.creatures[1].pos;
        let gap = ((a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
        assert!(gap > 0.5, "stacked creatures must push apart, gap={gap}");
    }

    #[tokio::test]
    async fn a_hostile_creature_bite_drops_a_heart_server_side() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        bite_setup(&mut room);
        room.simulate_creatures(0.1);
        assert_eq!(room.players.get(&1).unwrap().hp, MAX_HP - 1);
    }

    #[tokio::test]
    async fn a_creature_a_block_below_the_players_feet_still_bites() {
        // The real-world miss: a ground creature's center sits a block below the feet of a player
        // standing on top of a surface block. The old tight 0.5 lower bound dropped the bite; the
        // symmetric gap (matching offline) lands it.
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        room.peace = false;
        let spider = Creature::spawn(99, CreatureKind::Spider, 40.0, 40.0, |x, z| {
            room.world.surface_y(x, z)
        });
        let creature_y = spider.pos[1];
        let p = room.players.get_mut(&1).unwrap();
        p.x = 40.0;
        p.z = 40.0;
        p.y = creature_y + 1.0 + PLAYER_EYE_HEIGHT;
        p.hurt_at = Instant::now() - Duration::from_secs(5);
        room.creatures.clear();
        room.creatures.push(spider);
        room.simulate_creatures(0.05);
        assert_eq!(
            room.players.get(&1).unwrap().hp,
            MAX_HP - 1,
            "a creature a block below the feet still bites"
        );
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
        // Spawned 24 blocks away — a realistic SPAWN_RADIUS distance, and OUTSIDE the old 11-block chase
        // range. The regression this guards: hostiles spawn 11-28 blocks out, so if chase doesn't cover
        // that band they wander forever just out of reach and never bite (the "monsters do no damage" bug).
        let spider = Creature::spawn(99, CreatureKind::Spider, 84.0, 60.0, |x, z| {
            room.world.surface_y(x, z)
        });
        room.creatures.clear();
        room.creatures.push(spider);
        let start = room.players.get(&1).unwrap().hp;
        for _ in 0..400 {
            room.simulate_creatures(0.1);
        }
        let hp = room.players.get(&1).unwrap().hp;
        assert!(
            hp < start,
            "a creature spawned at SPAWN_RADIUS must chase in and bite (hp {start} -> {hp})"
        );
        let hurt = std::iter::from_fn(|| rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Hurt { .. }));
        assert!(hurt, "the bitten player gets a Hurt cue");
    }

    #[tokio::test]
    async fn a_bite_that_empties_the_hearts_respawns_at_spawn() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        bite_setup(&mut room);
        room.players.get_mut(&1).unwrap().hp = 1;
        room.simulate_creatures(0.1);
        let (bx, bz) = World::spawn_base();
        let p = room.players.get(&1).unwrap();
        assert_eq!(p.hp, MAX_HP);
        assert!(
            within_spawn_area(p, bx, bz),
            "the player respawns within the spawn area of the centre"
        );
        assert!(
            (0..50)
                .filter_map(|_| rx.try_recv_msg().ok())
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
        let (bx, bz) = World::spawn_base();
        let p = room.players.get(&1).unwrap();
        assert!(
            within_spawn_area(p, bx, bz),
            "the respawn lands within the spawn area of the centre"
        );
        assert_eq!(p.hp, MAX_HP);
        assert!(
            !p.move_synced,
            "the anti-cheat baseline resets so the snap is accepted"
        );
        assert!((0..50)
            .filter_map(|_| rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Respawn { .. })),);
    }

    // The spawn column is solid (built blocks stacked over the surface); a respawn must NOT drop the
    // player inside a block. The slot search nudges to a nearby clear column and the feet/head cells
    // are air.
    #[tokio::test]
    async fn respawn_never_lands_inside_a_solid_spawn_column() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        let (bx, bz) = World::spawn_base();
        let surface = room.world.surface_y(bx, bz);
        for y in (surface + 1)..(surface + 6) {
            room.world.set(bx, y, bz, sim::STONE);
        }
        room.on_input(1, ClientMsg::Respawn);
        let p = room.players.get(&1).unwrap();
        let feet = (p.y - PLAYER_EYE_HEIGHT).round() as i32;
        let fx = p.x.floor() as i32;
        let fz = p.z.floor() as i32;
        assert!(!room.world.is_solid(fx, feet, fz), "the feet cell is air");
        assert!(
            !room.world.is_solid(fx, feet + 1, fz),
            "the head cell is air"
        );
        assert!(
            (fx - bx).abs().max((fz - bz).abs())
                <= sim::SPAWN_AREA_RADIUS + sim::SPAWN_SEARCH_RADIUS,
            "the slot stays within the spawn area + search radius of the centre"
        );
    }

    fn within_spawn_area(player: &Player, base_x: i32, base_z: i32) -> bool {
        let reach = sim::SPAWN_AREA_RADIUS + sim::SPAWN_SEARCH_RADIUS;
        let dx = (player.x.floor() as i32 - base_x).abs();
        let dz = (player.z.floor() as i32 - base_z).abs();
        dx <= reach && dz <= reach
    }

    // Every respawn lands within the spawn area (random base + the slot nudge) AND on a clear column —
    // even when the centre base column is filled solid, the random base + spiral never drop the player
    // inside a block.
    #[tokio::test]
    async fn respawn_lands_within_the_spawn_area_on_a_clear_column() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        let (bx, bz) = World::spawn_base();
        let surface = room.world.surface_y(bx, bz);
        for y in (surface + 1)..(surface + 6) {
            room.world.set(bx, y, bz, sim::STONE);
        }
        for _ in 0..40 {
            room.on_input(1, ClientMsg::Respawn);
            let p = room.players.get(&1).unwrap();
            let feet = (p.y - PLAYER_EYE_HEIGHT).round() as i32;
            let fx = p.x.floor() as i32;
            let fz = p.z.floor() as i32;
            assert!(
                within_spawn_area(p, bx, bz),
                "respawn stays within the spawn area"
            );
            assert!(
                !room.world.is_solid(fx, feet, fz) && !room.world.is_solid(fx, feet + 1, fz),
                "respawn lands on a clear column, not inside a filled spawn column"
            );
        }
    }

    // A buggy client that doesn't self-unstick: an EditBatch fills the player's own body column with
    // solid blocks. The server must lift them out of the solid and tell their client to reposition.
    #[tokio::test]
    async fn an_edit_batch_onto_a_player_lifts_them_out_of_the_solid() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        let (col_x, col_z) = (60, 60);
        let feet = room.world.surface_y(col_x, col_z);
        {
            let p = room.players.get_mut(&1).unwrap();
            p.x = col_x as f32 + 0.5;
            p.z = col_z as f32 + 0.5;
            p.y = feet as f32 + PLAYER_EYE_HEIGHT;
            p.move_synced = true;
        }
        room.on_input(
            1,
            ClientMsg::EditBatch {
                edits: vec![
                    EditCell {
                        x: col_x,
                        y: feet,
                        z: col_z,
                        id: sim::STONE,
                    },
                    EditCell {
                        x: col_x,
                        y: feet + 1,
                        z: col_z,
                        id: sim::STONE,
                    },
                ],
            },
        );
        let p = room.players.get(&1).unwrap();
        let lifted_feet = (p.y - PLAYER_EYE_HEIGHT).floor() as i32;
        assert!(
            !room.world.is_solid(col_x, lifted_feet, col_z)
                && !room.world.is_solid(col_x, lifted_feet + 1, col_z),
            "the player ends up standing in clear space (feet {lifted_feet})"
        );
        assert!(
            lifted_feet > feet,
            "the player was raised above the new solid"
        );
        assert!(
            !p.move_synced,
            "the anti-cheat baseline resets so the lift snap is accepted"
        );
        let lifted = std::iter::from_fn(|| rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Respawn { y, .. } if y == p.y));
        assert!(lifted, "the player is told to reposition at the lifted y");
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
                .filter_map(|_| rx.try_recv_msg().ok())
                .any(|m| matches!(m, ServerMsg::Edit { id: 0, .. })),
            "the break is broadcast",
        );
    }

    #[tokio::test]
    async fn primary_actions_closer_than_the_interval_are_dropped() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        let start = Instant::now();
        // The first action is always accepted (last_action seeded a full interval in the past).
        assert!(room.accept_primary_action(1, start));
        // A second action one tick later is inside the throttle window, so it is dropped.
        assert!(!room.accept_primary_action(1, start + Duration::from_millis(50)));
        // Once the interval has fully elapsed, the next action is accepted again.
        assert!(room.accept_primary_action(1, start + ATTACK_MIN_INTERVAL));
    }

    #[tokio::test]
    async fn a_primary_action_swings_the_actors_avatar_for_everyone_else() {
        let mut room = test_room().await;
        let mut actor_rx = add_player(&mut room, 1, false);
        let mut other_rx = add_player(&mut room, 2, false);
        assert!(room.accept_primary_action(1, Instant::now()));
        // Everyone but the actor sees the actor's swing.
        let swung = std::iter::from_fn(|| other_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Swing { id: 1 }));
        assert!(swung, "the other player sees the actor swing");
        // The actor never gets its own swing back (it swings its own first-person view locally).
        let echoed = std::iter::from_fn(|| actor_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Swing { .. }));
        assert!(!echoed, "the actor does not receive its own swing");
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
        let got_role = std::iter::from_fn(|| guest_rx.try_recv_msg().ok()).any(|m| {
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
                .filter_map(|_| admin_rx.try_recv_msg().ok())
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
        let chats: Vec<ServerMsg> = std::iter::from_fn(|| listener_rx.try_recv_msg().ok())
            .filter(|m| matches!(m, ServerMsg::Chat { .. }))
            .collect();
        assert!(chats.is_empty(), "a disabled room must drop chat");
    }

    #[tokio::test]
    async fn chat_with_a_blocked_word_is_dropped() {
        let mut room = test_room().await;
        let mut listener_rx = add_player(&mut room, 2, false);
        let _sender_rx = add_player(&mut room, 1, false);

        room.on_input(
            1,
            ClientMsg::Chat {
                text: "you are a bitch".into(),
            },
        );
        let chats: Vec<ServerMsg> = std::iter::from_fn(|| listener_rx.try_recv_msg().ok())
            .filter(|m| matches!(m, ServerMsg::Chat { .. }))
            .collect();
        assert!(
            chats.is_empty(),
            "a message with a blocked word must be dropped"
        );
    }

    #[tokio::test]
    async fn clean_chat_is_broadcast() {
        let mut room = test_room().await;
        let mut listener_rx = add_player(&mut room, 2, false);
        let _sender_rx = add_player(&mut room, 1, false);

        room.on_input(
            1,
            ClientMsg::Chat {
                text: "lets build together".into(),
            },
        );
        let chats: Vec<ServerMsg> = std::iter::from_fn(|| listener_rx.try_recv_msg().ok())
            .filter(|m| matches!(m, ServerMsg::Chat { .. }))
            .collect();
        assert_eq!(chats.len(), 1, "a clean message must be broadcast");
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
            std::iter::from_fn(|| target_rx.try_recv_msg().ok()).collect();
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
    async fn a_banned_ip_still_admits_an_admin_or_moderator_but_refuses_a_player() {
        // A ban targets an IP. If a parent (admin) or helper (moderator) shares that banned address, they
        // must still get in to moderate; only an ordinary player from it stays refused.
        let mut room = test_room().await;
        let banned_ip = "203.0.113.50";
        room.hub
            .bans
            .ban(banned_ip.parse().unwrap(), "someone".into());

        let (admin_result, _a) =
            admit_from_ip(&mut room, "acc-a", "Parent", Role::Admin, banned_ip).await;
        assert!(admin_result.is_ok(), "a banned IP still admits an admin");
        let (mod_result, _m) =
            admit_from_ip(&mut room, "acc-m", "Helper", Role::Moderator, banned_ip).await;
        assert!(mod_result.is_ok(), "a banned IP still admits a moderator");
        let (player_result, _p) =
            admit_from_ip(&mut room, "acc-p", "Kid", Role::Player, banned_ip).await;
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
        let mut room = test_room().await;
        let _admin_rx = add_player(&mut room, 1, true);

        let admin_target_ip: IpAddr = "203.0.113.71".parse().unwrap();
        let _admin_target_rx = add_player(&mut room, 2, true);
        room.players.get_mut(&2).unwrap().ip = admin_target_ip;
        room.on_input(1, ClientMsg::AdminBan { id: 2 });
        assert!(
            room.players.contains_key(&2),
            "an admin target is not removed"
        );
        assert!(
            !room.hub.bans.is_banned(admin_target_ip),
            "an admin target's ip is never banned"
        );

        let mod_target_ip: IpAddr = "203.0.113.72".parse().unwrap();
        let _mod_target_rx = add_player(&mut room, 3, false);
        room.players.get_mut(&3).unwrap().is_moderator = true;
        room.players.get_mut(&3).unwrap().ip = mod_target_ip;
        room.on_input(1, ClientMsg::AdminBan { id: 3 });
        assert!(
            room.players.contains_key(&3),
            "a moderator target is not removed"
        );
        assert!(
            !room.hub.bans.is_banned(mod_target_ip),
            "a moderator target's ip is never banned"
        );

        let player_target_ip: IpAddr = "203.0.113.73".parse().unwrap();
        let _player_target_rx = add_player(&mut room, 4, false);
        room.players.get_mut(&4).unwrap().ip = player_target_ip;
        room.on_input(1, ClientMsg::AdminBan { id: 4 });
        assert!(
            !room.players.contains_key(&4),
            "a normal player is still banned"
        );
        assert!(
            room.hub.bans.is_banned(player_target_ip),
            "a normal player's ip is banned"
        );
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

    fn drain_kill_event(rx: &mut mpsc::Receiver<Outbound>) -> Option<(String, String)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv_msg() {
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
    async fn killing_a_creature_drops_a_heart_at_its_position() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        let chicken = Creature::spawn(60, CreatureKind::Chicken, 0.0, 0.0, sim::height_at);
        let death_pos = chicken.pos;
        room.creatures.push(chicken);
        room.players.get_mut(&1).unwrap().y = sim::height_at(0, 0) as f32 + 0.5;

        room.on_input(1, ClientMsg::Hit { id: 60 });
        assert_eq!(
            room.heart_drops.len(),
            1,
            "a defeated creature drops one heart"
        );
        assert_eq!(room.heart_drops[0].pos, death_pos);
    }

    #[tokio::test]
    async fn a_damaged_player_over_a_drop_gains_a_heart_and_consumes_it() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        let surface = sim::height_at(0, 0) as f32;
        room.drop_heart([0.0, surface, 0.0]);
        let p = room.players.get_mut(&1).unwrap();
        p.hp = 1;
        p.x = 0.0;
        p.z = 0.0;
        p.y = surface + PLAYER_EYE_HEIGHT;

        room.collect_hearts();
        assert_eq!(
            room.players.get(&1).unwrap().hp,
            2,
            "the player heals by one"
        );
        assert!(room.heart_drops.is_empty(), "the drop is consumed");
    }

    #[tokio::test]
    async fn a_damaged_player_walking_over_a_real_kill_drop_heals() {
        // Geometry of a real kill: the drop sits at the creature's body position (surface + the
        // creature's ground offset), not exactly at the player's feet. A damaged player standing on
        // the same ground walks over it and must still heal — the regression players reported.
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        let chicken = Creature::spawn(70, CreatureKind::Chicken, 0.0, 0.0, sim::height_at);
        let drop_pos = chicken.pos;
        room.drop_heart(drop_pos);
        let surface = sim::height_at(0, 0) as f32;
        let p = room.players.get_mut(&1).unwrap();
        p.hp = 1;
        p.x = 0.0;
        p.z = 0.0;
        p.y = surface + PLAYER_EYE_HEIGHT;

        room.collect_hearts();
        assert_eq!(
            room.players.get(&1).unwrap().hp,
            2,
            "walking onto a fresh kill drop heals by one"
        );
        assert!(room.heart_drops.is_empty(), "the drop is consumed");
    }

    #[tokio::test]
    async fn a_full_hp_player_still_picks_up_the_drop_without_overhealing() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        let surface = sim::height_at(0, 0) as f32;
        room.drop_heart([0.0, surface, 0.0]);
        let p = room.players.get_mut(&1).unwrap();
        p.hp = MAX_HP;
        p.x = 0.0;
        p.z = 0.0;
        p.y = surface + PLAYER_EYE_HEIGHT;

        room.collect_hearts();
        assert_eq!(
            room.players.get(&1).unwrap().hp,
            MAX_HP,
            "a full player never overheals"
        );
        assert!(
            room.heart_drops.is_empty(),
            "the drop is still picked up (collected) at full hp"
        );
    }

    #[tokio::test]
    async fn a_drop_expires_after_its_ttl() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, false);
        room.players.get_mut(&1).unwrap().hp = 1;
        // Far from the player so it can only leave via the TTL, and aged past HEART_TTL.
        room.drop_heart([500.0, 0.0, 500.0]);
        room.heart_drops[0].spawned_at = Instant::now() - HEART_TTL - Duration::from_secs(1);

        room.collect_hearts();
        assert!(
            room.heart_drops.is_empty(),
            "an old uncollected drop is removed"
        );
        assert_eq!(
            room.players.get(&1).unwrap().hp,
            1,
            "an out-of-reach drop never heals"
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
        assert_eq!(room.creatures.len(), 1, "a 2-hp cow survives the first hit");
        assert_eq!(room.creatures[0].hp, 1);
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

    #[tokio::test]
    async fn broadcast_serializes_once_and_sends_identical_bytes_to_every_player() {
        // The single-serialize win: the room must encode a fan-out message ONCE and send the same frame
        // to every connection, and those bytes must be byte-for-byte what the old per-connection
        // `serde_json::to_string(&msg)` produced — same wire format, just encoded one time for the room.
        let mut room = test_room().await;
        let mut rx_a = add_player(&mut room, 1, false);
        let mut rx_b = add_player(&mut room, 2, false);
        let snap = ServerMsg::Snapshot {
            tick: 7,
            players: vec![PlayerState(1, 1.0, 2.0, 3.0, 0.5, 0.1, 20, 4, 3)],
            creatures: vec![CreatureState(50, 4, -3.0, 63.5, 8.0, 0.2, 2, 2)],
            hearts: vec![HeartDropState(200, -5.0, 63.5, 0.0)],
        };
        let expected = serde_json::to_string(&snap).unwrap();
        room.broadcast(&snap);

        let Outbound::Frame(frame_a) = rx_a.try_recv().unwrap() else {
            panic!("a fan-out message must arrive as a pre-serialized Frame");
        };
        let Outbound::Frame(frame_b) = rx_b.try_recv().unwrap() else {
            panic!("a fan-out message must arrive as a pre-serialized Frame");
        };
        assert_eq!(
            &*frame_a,
            expected.as_str(),
            "frame must equal the old per-connection JSON"
        );
        assert_eq!(frame_a, frame_b, "every player gets the SAME bytes");
        assert!(
            Arc::ptr_eq(&frame_a, &frame_b),
            "the frame is shared, not re-serialized per player"
        );
    }

    #[tokio::test]
    async fn creature_population_never_exceeds_the_hard_cap_with_many_players() {
        // The production death spiral: with several players near each other, the union of their despawn
        // radii kept ever more creatures and the spawn refill compounded it. Simulate many players + a
        // pre-flooded population and tick for a while; the count must stay at/under MAX_CREATURES every
        // tick (so the O(n²) separation + bite passes stay cheap) — never accumulating.
        let mut room = test_room().await;
        room.peace = false;
        for id in 1..=6 {
            add_player(&mut room, id, false);
            let p = room.players.get_mut(&id).unwrap();
            p.x = id as f32 * 6.0;
            p.z = id as f32 * 6.0;
            p.move_synced = true;
        }
        // Pre-flood far past the cap so we prove the trim, not just the bounded spawn.
        for seed in 0..(MAX_CREATURES * 3) {
            let x = (seed % 11) as f32 * 5.0;
            let z = (seed / 11) as f32 * 5.0;
            room.creatures.push(Creature::spawn(
                900 + seed as u32,
                CreatureKind::Slime,
                x,
                z,
                sim::height_at,
            ));
        }
        for _ in 0..400 {
            room.simulate_creatures(0.05);
            assert!(
                room.creatures.len() <= MAX_CREATURES,
                "population exceeded the cap: {} > {MAX_CREATURES}",
                room.creatures.len()
            );
        }
    }

    #[tokio::test]
    async fn cap_creatures_keeps_the_nearest_and_drops_the_farthest() {
        // Three creatures at increasing distance from a lone player; capping to two must keep the two
        // closest (ids 1 and 2) and drop the farthest (id 3).
        let players = [[0.0_f32, 0.0_f32]];
        let mut creatures = vec![
            Creature::spawn(1, CreatureKind::Pig, 1.0, 0.0, sim::height_at),
            Creature::spawn(2, CreatureKind::Pig, 5.0, 0.0, sim::height_at),
            Creature::spawn(3, CreatureKind::Pig, 50.0, 0.0, sim::height_at),
        ];
        cap_creatures(&mut creatures, &players, 2);
        let mut kept: Vec<u32> = creatures.iter().map(|c| c.id).collect();
        kept.sort_unstable();
        assert_eq!(kept, vec![1, 2], "the two nearest creatures are kept");
    }

    fn drain_reset_event(rx: &mut mpsc::Receiver<Outbound>) -> Option<String> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv_msg() {
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
    async fn admin_reset_world_also_wipes_every_player_score_and_inventory() {
        let mut room = test_room().await;
        add_player(&mut room, 1, true);
        let mut other_rx = add_player(&mut room, 2, false);
        room.players.get_mut(&1).unwrap().score = 8;
        let other = room.players.get_mut(&2).unwrap();
        other.score = 4;
        other.hp = 1;
        other.inventory.insert(sim::STONE, 7);

        room.on_input(1, ClientMsg::AdminResetWorld);

        assert_eq!(
            room.players.get(&1).unwrap().score,
            0,
            "the admin's score is wiped"
        );
        let other = room.players.get(&2).unwrap();
        assert_eq!(other.score, 0, "every player's score is wiped");
        assert_eq!(other.hp, MAX_HP, "hearts are refilled");
        assert!(
            other.inventory.is_empty(),
            "the banked inventory is emptied"
        );
        assert_eq!(
            drain_inventory(&mut other_rx, sim::STONE),
            Some((0, true)),
            "the cleared inventory is pushed to the player",
        );
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
    async fn a_moderator_cannot_grant_any_role() {
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
            !room.players.get(&3).unwrap().is_moderator,
            "a moderator cannot grant any role, not even moderator"
        );
    }

    #[tokio::test]
    async fn a_moderator_can_kick_but_not_ban() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        room.players.get_mut(&1).unwrap().is_moderator = true;
        add_player(&mut room, 2, false);
        add_player(&mut room, 3, false);

        room.on_input(1, ClientMsg::AdminBan { id: 2 });
        assert!(room.players.contains_key(&2), "a moderator cannot ban");

        room.on_input(1, ClientMsg::AdminKick { id: 3 });
        assert!(!room.players.contains_key(&3), "a moderator can kick");
    }

    #[tokio::test]
    async fn guest_joins_without_a_claim_and_gets_a_unique_name() {
        let mut room = test_room().await;
        let (conn, _conn_rx) = mpsc::channel::<Outbound>(64);
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
    ) -> (Result<PlayerId, String>, mpsc::Receiver<Outbound>) {
        let (conn, conn_rx) = mpsc::channel::<Outbound>(64);
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
            .claim_account("acme", "kid@x.com", "Kid")
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
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;

        let (refused, _rx) = admit_account(&mut room, &acc, "Kid", Role::Player).await;
        assert_eq!(refused, Err("needs_approval".into()));
        // The held-out account is now pending.
        let pending = room.hub.db.pending_approvals("acme").await.unwrap();
        assert_eq!(pending.len(), 1);

        // After an admin approves it, the same account is admitted.
        room.hub.db.approve_account("acme", &acc).await.unwrap();
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
            .claim_account("acme", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        let (result, _rx) = admit_account(&mut room, &acc, "Parent", Role::Admin).await;
        assert!(result.is_ok(), "an admin is never held out by the gate");
        assert!(
            room.hub
                .db
                .pending_approvals("acme")
                .await
                .unwrap()
                .is_empty(),
            "an admin never becomes a pending request"
        );
    }

    #[tokio::test]
    async fn approval_required_holds_an_anonymous_guest_then_admits_after_approve() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        // An anonymous guest (no account, no login) is HELD for approval — never told to log in.
        let (held, _rx) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.50").await;
        assert_eq!(
            held,
            Err("needs_approval".into()),
            "a guest waits for approval instead of being asked to log in"
        );
        // Recorded as pending, keyed by IP so the admin can approve it.
        let pending = room.hub.db.pending_approvals(&room.key.0).await.unwrap();
        assert_eq!(pending.len(), 1);
        // After the admin approves that IP key, the same guest is admitted on retry.
        room.hub
            .db
            .approve_account(&room.key.0, "ip:203.0.113.50")
            .await
            .unwrap();
        let (allowed, _rx2) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.50").await;
        assert!(allowed.is_ok(), "an approved guest is admitted");
    }

    #[tokio::test]
    async fn reject_is_one_shot_then_a_fresh_join_is_held_again() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        let acc = room
            .hub
            .db
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;
        // The admin rejected the held request: the next join is told "rejected" exactly once.
        room.hub
            .db
            .record_approval_request("acme", &acc, "Kid", "kid@x.com")
            .await
            .unwrap();
        room.hub
            .db
            .reject_approval_request("acme", &acc)
            .await
            .unwrap();

        let (rejected, _rx) = admit_account(&mut room, &acc, "Kid", Role::Player).await;
        assert_eq!(
            rejected,
            Err("rejected".into()),
            "the rejected attempt ends"
        );
        assert!(
            !room.hub.db.is_rejected("acme", &acc).await.unwrap(),
            "the one-shot reject is cleared so a fresh join is not stuck on rejected"
        );

        // A fresh join is held for approval again, re-recording the pending row (admins re-notified).
        let (held, _rx2) = admit_account(&mut room, &acc, "Kid", Role::Player).await;
        assert_eq!(
            held,
            Err("needs_approval".into()),
            "the next join is held for approval, not turned away forever"
        );
        let pending = room.hub.db.pending_approvals("acme").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].account_id, acc);
    }

    #[tokio::test]
    async fn banning_a_pending_player_bans_the_ip_and_drops_the_request() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        let mut admin_rx = add_player(&mut room, 1, true);
        // A held guest, recorded as pending by their IP key.
        let (held, _rx) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.77").await;
        assert_eq!(held, Err("needs_approval".into()));
        assert_eq!(
            room.hub.db.pending_approvals("acme").await.unwrap().len(),
            1
        );

        room.on_input(
            1,
            ClientMsg::AdminBanPending {
                account_id: "ip:203.0.113.77".into(),
            },
        );
        // The ip ban is applied synchronously; the request clear is spawned, so let it run.
        let banned_ip: IpAddr = "203.0.113.77".parse().unwrap();
        assert!(
            room.hub.bans.is_banned(banned_ip),
            "the pending ip is banned"
        );
        for _ in 0..50 {
            if room
                .hub
                .db
                .pending_approvals("acme")
                .await
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            room.hub
                .db
                .pending_approvals("acme")
                .await
                .unwrap()
                .is_empty(),
            "the banned player is removed from the pending list"
        );

        // The banned address is now turned away at the join gate (the same check the connect path runs).
        let (conn, _conn_rx) = mpsc::channel::<Outbound>(64);
        let (reply, reply_rx) = oneshot::channel();
        let look = Appearance {
            skin: "#fff".into(),
            shirt: "#fff".into(),
            hair: "#fff".into(),
        };
        room.on_join(String::new(), String::new(), look, banned_ip, conn, reply)
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
        let mut room = test_room().await;
        let _admin_rx = add_player(&mut room, 1, true);
        let acc = room
            .hub
            .db
            .claim_account("acme", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        room.hub
            .db
            .set_admin_by_name("acme", "Parent", true)
            .await
            .unwrap();

        room.on_input(
            1,
            ClientMsg::AdminBanPending {
                account_id: acc.clone(),
            },
        );
        let before = room.hub.bans.list_named().len();
        assert_eq!(before, 0, "an account-keyed ban-pending adds no ban");
    }

    #[tokio::test]
    async fn admin_toggles_approval_and_approves_a_pending_account() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        let acc = room
            .hub
            .db
            .claim_account("acme", "kid@x.com", "Kid")
            .await
            .unwrap()
            .account_id;

        room.on_input(1, ClientMsg::AdminSetApproval { on: true });
        assert!(room.approval_required);
        let required = std::iter::from_fn(|| admin_rx.try_recv_msg().ok()).find_map(|m| match m {
            ServerMsg::RoomState {
                approval_required, ..
            } => Some(approval_required),
            _ => None,
        });
        assert_eq!(required, Some(true), "the toggle broadcasts RoomState");

        room.hub
            .db
            .record_approval_request("acme", &acc, "Kid", "kid@x.com")
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
            if room.hub.db.is_approved("acme", &acc).await.unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(room.hub.db.is_approved("acme", &acc).await.unwrap());
        assert!(room
            .hub
            .db
            .pending_approvals("acme")
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

    /// Admit a guest/account from a chosen IP, so the play-time + mode-block paths can be exercised.
    async fn admit_from_ip(
        room: &mut Room,
        account_id: &str,
        name: &str,
        role: Role,
        ip: &str,
    ) -> (Result<PlayerId, String>, mpsc::Receiver<Outbound>) {
        let (conn, conn_rx) = mpsc::channel::<Outbound>(64);
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
            ip.parse().unwrap(),
            conn,
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

    #[test]
    fn playtime_key_keys_anon_by_ip_and_account_by_id() {
        assert_eq!(
            playtime_key("", "203.0.113.7".parse().unwrap()),
            "ip:203.0.113.7"
        );
        assert_eq!(playtime_key("acc1", "203.0.113.7".parse().unwrap()), "acc1");
    }

    #[tokio::test]
    async fn anonymous_playtime_accrues_by_ip_and_kicks_with_time_up() {
        let mut room = test_room().await;
        // A 1-minute budget within a 24h window for this tenant.
        room.hub
            .db
            .set_tenant_playtime(&room.key.0, 1, 24)
            .await
            .unwrap();
        // An anonymous guest (empty account id) joins from a known IP.
        let (admitted, mut rx) =
            admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.7").await;
        let id = admitted.expect("a guest within budget is admitted");
        // Pretend the session started two minutes ago, past the 1-minute budget.
        let two_min_ms = 2 * 60_000u64;
        room.players.get_mut(&id).unwrap().joined_at_ms = epoch_ms() - two_min_ms;
        // The status sweep flushes the time and sends the over-budget guest to the lobby.
        room.tick = STATUS_EVERY_TICKS - 1;
        room.tick(0.05);
        assert_eq!(first_error_code(&mut rx).as_deref(), Some("time_up"));
        assert!(!room.players.contains_key(&id), "the guest is removed");
        // The accrual write is fire-and-forget (spawned off the tick), so let it land before reading.
        let mut used = 0;
        for _ in 0..50 {
            tokio::task::yield_now().await;
            used = room
                .hub
                .db
                .playtime_used(
                    &room.key.0,
                    "ip:203.0.113.7",
                    24 * 3_600_000,
                    epoch_ms() as i64,
                )
                .await
                .unwrap();
            if used >= 60_000 {
                break;
            }
        }
        assert!(used >= 60_000, "anonymous time accrued by IP, got {used}ms");
        // The IP is now over budget, so the next guest from it is turned away with "time_up".
        let (blocked, _rx2) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.7").await;
        assert_eq!(blocked, Err("time_up".into()), "the IP is over budget");
    }

    #[tokio::test]
    async fn online_blocked_rejects_a_non_admin_join_but_admits_admins() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_modes(&room.key.0, false, true)
            .await
            .unwrap();
        let (refused, _rx) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.9").await;
        assert_eq!(refused, Err("online_blocked".into()));
        // An admin still gets in so they can re-enable online play from the panel.
        let acc = room
            .hub
            .db
            .claim_account("acme", "parent@x.com", "Parent")
            .await
            .unwrap()
            .account_id;
        let (allowed, _rx) =
            admit_from_ip(&mut room, &acc, "Parent", Role::Admin, "203.0.113.9").await;
        assert!(allowed.is_ok(), "an admin is admitted to manage the world");
    }

    #[tokio::test]
    async fn admin_cannot_disable_the_last_mode() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 1, true);
        // Start online-only, then try to also disable online: the toggle must be ignored.
        room.on_input(
            1,
            ClientMsg::AdminSetModes {
                online_allowed: true,
                offline_allowed: false,
            },
        );
        assert!(room.online_allowed && !room.offline_allowed);
        room.on_input(
            1,
            ClientMsg::AdminSetModes {
                online_allowed: false,
                offline_allowed: false,
            },
        );
        assert!(
            room.online_allowed,
            "disabling the last enabled mode is rejected"
        );
    }

    #[tokio::test]
    async fn admin_sets_playtime_limit_and_broadcasts() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        room.on_input(
            1,
            ClientMsg::AdminSetLimits {
                playtime_limit_min: 5,
                playtime_window_h: 24,
            },
        );
        assert_eq!(room.playtime_limit_ms, 5 * 60_000);
        assert_eq!(room.playtime_window_ms, 24 * 3_600_000);
        let limits = std::iter::from_fn(|| admin_rx.try_recv_msg().ok()).find_map(|m| match m {
            ServerMsg::RoomState {
                playtime_limit_min,
                playtime_window_h,
                ..
            } => Some((playtime_limit_min, playtime_window_h)),
            _ => None,
        });
        assert_eq!(limits, Some((5, 24)), "the limit broadcasts on RoomState");
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
        assert_eq!(valid_structure_kind("hero2"), Some("hero2".to_string()));
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
    fn drain_inventory(rx: &mut mpsc::Receiver<Outbound>, block: u8) -> Option<(u32, bool)> {
        let mut latest = None;
        while let Ok(msg) = rx.try_recv_msg() {
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
        let placed = std::iter::from_fn(|| other_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Edit { .. }));
        assert!(!placed, "a rejected place is never broadcast");
        let _ = rx.try_recv_msg();
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
