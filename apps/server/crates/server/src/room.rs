//! One authoritative room per (tenant, world). Runs a fixed-rate tick, owns the world
//! state, validates every client input, and broadcasts snapshots. The server is the
//! single source of truth; clients predict locally and reconcile from snapshots.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{
    snapshot_codec::{encode_delta, encode_keyframe, SnapshotView},
    BanEntry, Brand, ClientMsg, CreatureState, EditCell, EditOp, HeartDropState, InventoryItem,
    PlayerId, PlayerMeta, PlayerState, ServerMsg,
};
use rand::Rng;
use rayon::prelude::*;
use sim::World;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::creatures::{separate_creatures, Creature, CreatureKind};
use crate::db::Role;
use crate::hub::{Hub, PlayerInfo, RoomKey, RoomSnapshot, TenantCfg};
use crate::spatial_grid::SpatialGrid;

// Bulk edits (magic structures, and the world handed to a joining player) are capped so one player
// cannot flood the room or build across the whole map.
const MAX_BATCH_EDITS: usize = 8192;
const BATCH_RADIUS: f32 = 48.0;
// Cells per outgoing EditBatch frame, matching the client; keeps each message under the text cap.
const BATCH_CHUNK_SIZE: usize = 256;
// Chebyshev radius (in EDIT chunks) of the world a player has streamed: every chunk within this many
// chunks of the one under the player is loaded for them. Sized so the loaded square always covers the
// AOI reach (`aoi::AOI_RADIUS`) regardless of where in its chunk the player stands: the farthest
// in-AOI column is AOI_RADIUS away, and the player may sit a full chunk-edge from the near boundary, so
// ceil((AOI_RADIUS + EDIT_CHUNK_SIZE) / EDIT_CHUNK_SIZE) chunks of reach are needed. With AOI_RADIUS=512
// and EDIT_CHUNK_SIZE=128 that is 5 — every edit a player could see is in a chunk they have loaded.
const LOAD_CHUNK_RADIUS: i32 = 5;

const _: () = assert!(
    (LOAD_CHUNK_RADIUS * sim::EDIT_CHUNK_SIZE) as f32
        >= crate::aoi::AOI_RADIUS + sim::EDIT_CHUNK_SIZE as f32
);

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
// When a player's socket drops, their slot is kept (avatar frozen in place) for this long so a brief
// internet blip lets them RESUME the same id/position/score/inventory instead of blinking out and back
// as a brand-new player. Only once a disconnected slot outlives the window is it pruned with a `Left`.
const RECONNECT_GRACE: Duration = Duration::from_secs(8);

/// Cosmetic look a player picks before joining (validated server-side, broadcast to everyone).
pub struct Appearance {
    pub skin: String,
    pub shirt: String,
    pub hair: String,
}

/// What a connection's writer task receives. A fan-out JSON message (event, roster, …) is serialized
/// ONCE by the room and shared as a `Frame` across every player. The hot per-tick snapshot is encoded
/// ONCE to a compact binary blob and shared as `Binary`, sent as a WebSocket binary frame. A per-player
/// message (welcome, inventory, error, …) travels as `One` and is serialized by the writer task itself.
pub enum Outbound {
    One(ServerMsg),
    Frame(Arc<str>),
    Binary(Arc<[u8]>),
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
        /// The connection task's already-measured latency. The room reads it straight into the snapshot;
        /// ping is owned by the socket round-trip (see `conn.rs`), never the room's tick load.
        ping: Arc<AtomicU32>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    },
    Input {
        id: PlayerId,
        msg: ClientMsg,
    },
    Leave {
        id: PlayerId,
        /// The departing socket's outbound channel, so the room can prove this Leave belongs to the
        /// player's CURRENT connection (`same_channel`) and ignore a stale one from a socket already
        /// replaced by a reconnect — without it, a late Leave would freeze a live, resumed player.
        conn: mpsc::Sender<Outbound>,
        /// True when the client closed cleanly (a WebSocket Close frame — page reload / leave). A clean
        /// leave removes the player at once; an abrupt drop (no Close frame) holds the slot for reconnect.
        clean: bool,
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
    // Latency measured by the connection task (its own socket heartbeat in `conn.rs`), shared so the room
    // reads it into the snapshot. A busy/late tick never touches it — ping is the round-trip, not tick load.
    ping: Arc<AtomicU32>,
    score: u32,
    // PvP kills landed by this player (a hit that brought another player to 0 hp). Carried in the
    // Roster so the presence list can rank players when pvp is on; never affects the leaderboard.
    pvp_kills: u32,
    conn: mpsc::Sender<Outbound>,
    // True until this connection has received a full keyframe it can build deltas on. Set when the player
    // joins or resumes (a new socket has no baseline), so the next snapshot it gets is a KEYFRAME, not a
    // delta against state it never saw; cleared once that keyframe is sent.
    needs_keyframe: bool,
    // This connection's own last-sent snapshot view (only the entities within its AOI), the baseline its
    // next per-tick delta is encoded against. Per-connection because AOI culling makes every player's view
    // differ; the ids present here also drive the AOI hysteresis (an entity already in this set leaves only
    // once it passes the upper bound). Reset to an unmatched tick on join/resume so the first frame is a keyframe.
    snapshot_baseline: SnapshotBaseline,
    // When the player's socket dropped, if it currently is. `Some` freezes the avatar in place and holds
    // the slot for RECONNECT_GRACE: a rejoin with the same identity resumes it; otherwise the tick prunes
    // it (a single `Left`). `None` is a live, connected player. A resume clears it back to `None`.
    disconnected_at: Option<Instant>,
    last_seen: Instant,
    last_move: Instant,
    // False until the player's first in-world move is accepted. That first move is taken verbatim as the
    // anti-cheat baseline (the client spawns/restores wherever it likes); only later moves are speed-checked.
    move_synced: bool,
    // Server-owned health: hearts left, and when the player last took damage (for the hurt cooldown).
    hp: u8,
    hurt_at: Instant,
    // The edit chunks this connection has been streamed (and so renders the built structures for). The
    // join seeds it with the chunks around spawn; the tick adds each newly-entered chunk as the player
    // moves. A live block Edit is broadcast ONLY to players whose set contains its chunk; a far player
    // without it gets the chunk's full current state when they later enter (so they never miss an edit).
    loaded_chunks: HashSet<(i32, i32)>,
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

/// One connection's last-sent snapshot view (its AOI-filtered entities), the baseline its per-tick delta
/// is encoded against. Starts at a tick no real tick can match, so the first frame each connection gets is
/// a keyframe; after each broadcast it becomes that connection's just-sent view.
#[derive(Default)]
struct SnapshotBaseline {
    tick: u64,
    players: Vec<PlayerState>,
    creatures: Vec<CreatureState>,
    hearts: Vec<HeartDropState>,
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

// The ban/reclaim/idle sweep + admin telemetry don't need 30Hz; running them at ~2Hz keeps the hot tick
// loop cheap (no per-tick DashMap lookups or player clones) without users noticing the slower cadence.
const STATUS_EVERY_TICKS: u64 = 15; // 0.5s @ 30Hz
                                    // The snapshot stream is keyframe + deltas: a full keyframe every this-many ticks (~2s @ 30Hz) bounds
                                    // the baseline and lets any desynced client resync; every other tick is a delta against the baseline.
const KEYFRAME_INTERVAL_TICKS: u64 = 60;
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
                ping,
                reply,
            } => self.on_join(name, claim, look, ip, conn, ping, reply).await,
            RoomCmd::Input { id, msg } => self.on_input(id, msg),
            RoomCmd::Leave { id, conn, clean } => self.on_leave(id, &conn, clean),
            RoomCmd::Rename {
                account_id,
                new_name,
                old_name,
            } => self.on_rename(&account_id, &new_name, &old_name),
            RoomCmd::Announce(msg) => self.broadcast(&msg),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn on_join(
        &mut self,
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<Outbound>,
        ping: Arc<AtomicU32>,
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
                    ping,
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
            ping,
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
        ping: Arc<AtomicU32>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        // Reconnect resume: a player whose socket dropped within RECONNECT_GRACE rejoins straight back
        // into their held slot (same id, position, score, inventory, hp) — no Left/Join churn, others
        // saw at most a brief freeze. They already cleared every gate at the original join, so resume
        // skips them. Matched by identity: account for a logged-in player, IP for a guest.
        if let Some(id) = self.try_resume(&account_id, ip, &look, &conn, &ping) {
            let _ = reply.send(Ok(id));
            return;
        }
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
        // Admins are never blocked by the play-time budget — even out of time they keep playing and can
        // run the lobby/in-game admin panel. Moderators and players ARE subject to it.
        if self.playtime_limit_ms > 0 && !role.is_admin() {
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
            ping,
            score: 0,
            pvp_kills: 0,
            conn: conn.clone(),
            needs_keyframe: true,
            snapshot_baseline: SnapshotBaseline::default(),
            disconnected_at: None,
            last_seen: now,
            last_move: now,
            move_synced: false,
            hp: MAX_HP,
            hurt_at: now,
            loaded_chunks: HashSet::new(),
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
        // Register the player (with an empty loaded set), then stream only the edit chunks around their
        // spawn — NOT the whole world. The base terrain is procedural (the client regenerates it for any
        // position), so a joiner sees correct terrain at once; only the chunks near spawn need their
        // built structures streamed, and the per-tick stream feeds the rest in as they move.
        self.players.insert(id, player);
        self.stream_chunks(id);
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
        // The fresh player's inventory (empty + infinite by default), sent after it is registered.
        self.send_inventory(id);
        // Everyone gets the refreshed identity roster so the new player's avatar can render at once
        // (the per-tick Snapshot is slim and carries no names/colors).
        self.announce_roster();
        self.empty_since = None;
        let _ = reply.send(Ok(id));
        tracing::info!(tenant = %self.key.0, world = %self.key.1, %id, "player joined");
    }

    /// A socket dropped: instead of removing the player and blinking them out for everyone, freeze their
    /// slot (avatar held in place) and start the reconnect grace, so a quick rejoin RESUMES them. The
    /// tick prunes the slot (with a single `Left`) only if the grace expires. Ignores a stale Leave from
    /// a socket the player has already reconnected over (`same_channel` no longer matches the live conn).
    fn on_leave(&mut self, id: PlayerId, conn: &mpsc::Sender<Outbound>, clean: bool) {
        let Some(player) = self.players.get(&id) else {
            return;
        };
        if !player.conn.same_channel(conn) {
            return;
        }
        if player.disconnected_at.is_some() {
            return;
        }
        // A clean close (page reload / leaving the tab) removes the player at once, so their avatar
        // vanishes for everyone immediately. Only an abrupt drop (no Close frame — lost internet) holds
        // the slot for RECONNECT_GRACE so a reconnect can resume it.
        if clean {
            self.players.remove(&id);
            self.broadcast(&ServerMsg::Left { id });
            self.announce_roster();
            tracing::debug!(tenant = %self.key.0, %id, "player left cleanly, removed immediately");
            return;
        }
        self.players
            .get_mut(&id)
            .expect("player present")
            .disconnected_at = Some(Instant::now());
        self.announce_roster();
        tracing::debug!(tenant = %self.key.0, %id, "player dropped, holding slot for reconnect");
    }

    /// Find a slot currently within its reconnect grace whose identity matches this rejoin, and resume
    /// it on the fresh connection: swap in the new socket, refresh the look, clear the disconnect mark,
    /// and replay Welcome + the world + settings (the new socket has nothing) so the player drops back
    /// where they froze with their score/inventory/hp intact. Returns the resumed id, or `None` when
    /// there is no matching held slot (a normal fresh join). Matched by account for a logged-in player,
    /// by IP for a guest — mirroring `playtime_key`'s identity rule.
    fn try_resume(
        &mut self,
        account_id: &str,
        ip: IpAddr,
        look: &Appearance,
        conn: &mpsc::Sender<Outbound>,
        ping: &Arc<AtomicU32>,
    ) -> Option<PlayerId> {
        let now = Instant::now();
        let id = self.players.values().find_map(|p| {
            let held = p.disconnected_at?;
            if now.duration_since(held) > RECONNECT_GRACE {
                return None;
            }
            let matches = if account_id.is_empty() {
                p.account_id.is_empty() && p.ip == ip
            } else {
                p.account_id == account_id
            };
            matches.then_some(p.id)
        })?;
        let (spawn, role_admin, role_moderator) = {
            let p = self.players.get_mut(&id)?;
            p.conn = conn.clone();
            // The new socket measures its own latency: adopt the new connection's ping atomic so the
            // resumed player's snapshot reflects the live round-trip, not the dead socket's last reading.
            p.ping = ping.clone();
            // A fresh socket has no baseline — its next snapshot must be a keyframe, not a delta. Clear the
            // held connection's stored view too, so the keyframe (and later deltas) start from an empty set.
            p.needs_keyframe = true;
            p.snapshot_baseline = SnapshotBaseline::default();
            // The fresh socket holds no world — clear the loaded set so the re-stream below hands it the
            // CURRENT chunks around the frozen position (folding in any edits made while it was away),
            // instead of trusting a baseline the new connection never received.
            p.loaded_chunks.clear();
            p.disconnected_at = None;
            p.last_seen = now;
            p.skin = sanitize_color(&look.skin, "#f2c18b");
            p.shirt = sanitize_color(&look.shirt, "#ff5d2e");
            p.hair = sanitize_color(&look.hair, "#3a2a1a");
            ([p.x, p.y, p.z], p.is_admin, p.is_moderator)
        };
        conn.send_one(ServerMsg::Welcome {
            you: id,
            tenant: self.key.0.clone(),
            world: self.key.1.clone(),
            brand: self.brand.clone(),
            tick_hz: self.tick_hz,
            spawn,
            admin: role_admin,
            moderator: role_moderator,
            version: server_version(),
        });
        self.stream_chunks(id);
        conn.send_one(self.room_state());
        self.send_inventory(id);
        self.announce_roster();
        tracing::info!(tenant = %self.key.0, world = %self.key.1, %id, "player resumed");
        Some(id)
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
        self.announce_roster();
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
            // Ping is measured connection-local now (see conn.rs); a Pong is never forwarded to the room.
            ClientMsg::Pong { .. } => {}
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
            // AOI-filtered: only players who have this edit's chunk loaded get the live Edit; a far player
            // gets the chunk's current state (with this edit folded in) when they later enter it.
            if let ServerMsg::Edit { x, z, .. } = m {
                self.broadcast_edit_in_chunk(sim::edit_chunk_of(x, z), &m);
            }
            // Placing is an arm action too: swing the placer's avatar for the nearby players who could see
            // it (a break in co-op comes through Dig, which already swings via accept_primary_action).
            if let Some(p) = self.players.get(&id) {
                self.broadcast_near(p.x, p.z, id, &ServerMsg::Swing { id });
            }
            self.lift_stuck_players();
        }
        if let Some(ServerMsg::EditBatch { edits, .. }) = batch_out.as_ref() {
            for c in edits {
                self.world.set(c.x, c.y, c.z, c.id);
            }
            self.dirty = true;
            tracing::debug!(count = edits.len(), by = %id, "edit batch applied");
        }
        if let Some(ServerMsg::EditBatch { edits, by }) = batch_out {
            self.broadcast_edit_batch_by_chunk(&edits, by);
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
        let actor_is_admin = admin.is_admin;
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
        // A moderator (kid) may not kick an admin (parent); an admin can still kick anyone.
        if !ban && !actor_is_admin && target.is_admin {
            tracing::debug!(%admin_id, %target_id, "kick ignored: moderator cannot kick an admin");
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
        self.announce_roster();
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
        // Zero every progress metric except the banked inventory: stars/score and the live pvp-kill
        // count here; the persisted record/trophies (the leaderboard) below via db.reset_scores.
        for p in self.players.values_mut() {
            p.score = 0;
            p.pvp_kills = 0;
        }
        // The wiped pvp-kill count rides the roster, so push the refreshed roster now.
        self.announce_roster();
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
            self.announce_roster();
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
        // Reflect the new badge for everyone immediately.
        self.announce_roster();
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
        let (actor_x, actor_z) = (p.x, p.z);
        // Every accepted primary action (dig tap / creature hit / pvp attack) swings the actor's avatar
        // arm for the nearby players who could see it; the actor already swung their own first-person view
        // locally. Purely cosmetic — no gameplay change.
        self.broadcast_near(actor_x, actor_z, id, &ServerMsg::Swing { id });
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
        // The nearby players who could see the target take the hit get the same flash on it (the attacker
        // played it locally; the target is told directly via Hurt above).
        self.broadcast_near(
            target_x,
            target_z,
            attacker_id,
            &ServerMsg::Attack {
                kind: "player".into(),
                id: target_id,
            },
        );
        if died {
            let mut scored = false;
            if let Some(attacker) = self.players.get_mut(&attacker_id) {
                attacker.pvp_kills = attacker.pvp_kills.saturating_add(1);
                scored = true;
            }
            self.respawn(target_id);
            // The bumped pvp-kill count rides the roster, so refresh it for everyone.
            if scored {
                self.announce_roster();
            }
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

    /// The static identity of every online player, so the per-tick Snapshot can stay slim. Broadcast
    /// only when the roster MATERIALLY changes (join/leave/rename/role/pvp-kill/away-toggle), never on
    /// a periodic cadence — a 1000-player roster re-sent twice a second was the dominant bandwidth.
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
                    pvp_kills: p.pvp_kills,
                    away: p.disconnected_at.is_some(),
                })
                .collect(),
        }
    }

    /// Push the current roster to everyone. Call this at every roster-affecting transition (the cadence
    /// is event-driven now, not periodic), and at most once per handler to avoid duplicate frames.
    fn announce_roster(&self) {
        self.broadcast(&self.roster_msg());
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
            // Any removal below (prune/kick/time-up) is a roster change; announce once after the sweep so
            // a single tick that drops several players still emits exactly one refreshed roster.
            let mut roster_changed = false;
            // Prune slots whose reconnect grace expired: the player never came back, so remove them and
            // broadcast a single `Left` now (the only point the avatar blinks out for everyone else).
            let expired: Vec<PlayerId> = self
                .players
                .values()
                .filter_map(|p| p.disconnected_at.map(|at| (p.id, at)))
                .filter(|(_, at)| now.duration_since(*at) > RECONNECT_GRACE)
                .map(|(id, _)| id)
                .collect();
            for id in expired {
                self.players.remove(&id);
                self.broadcast(&ServerMsg::Left { id });
                roster_changed = true;
                tracing::debug!(tenant = %self.key.0, %id, "reconnect grace expired, pruned");
            }

            let idle = Duration::from_secs(self.hub.limits.idle_secs);
            let mut kicked: Vec<PlayerId> = Vec::new();
            for p in self.players.values() {
                // A slot held for reconnect is left alone here; the grace prune above owns its lifetime.
                if p.disconnected_at.is_some() {
                    continue;
                }
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
                roster_changed = true;
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
                    if p.playtime_baseline_ms + session >= limit && !p.is_admin {
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
                    roster_changed = true;
                }
            }

            if roster_changed {
                self.announce_roster();
            }
        }

        // Stream each connected player the edit chunks they have newly entered since last tick, so built
        // structures pop in as they move (the join only seeded the chunks around spawn). A frozen slot
        // held for reconnect is skipped — its dead socket gets the current chunks on resume instead.
        let streaming: Vec<PlayerId> = self
            .players
            .values()
            .filter(|p| p.disconnected_at.is_none())
            .map(|p| p.id)
            .collect();
        for id in streaming {
            self.stream_chunks(id);
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
                    p.ping.load(Ordering::Relaxed),
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
        self.broadcast_snapshot(self.tick, &states, &creatures, &hearts);

        // The roster is no longer re-sent here on a cadence; it's broadcast event-driven at each
        // roster-affecting transition (join/leave/rename/role/pvp-kill/away-toggle). Stats stay periodic.
        if self.tick.is_multiple_of(STATUS_EVERY_TICKS) {
            self.publish_stats(now);
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

    /// Fan the hot per-tick snapshot out to every player as a keyframe + delta stream, AOI-filtered PER
    /// CONNECTION: each receiving player's frame carries only the entities within its area of interest
    /// (its OWN record always, plus every other player/creature/heart within `aoi::AOI_RADIUS`, sticky to
    /// `+ AOI_HYSTERESIS` once in view). A just-joined/resumed connection (or every connection on the
    /// periodic keyframe tick) gets a keyframe of ITS view; otherwise a delta against ITS OWN stored
    /// baseline. Single-serialize across players is intentionally traded away — every player's content
    /// differs under AOI — so this is one small encode per connection (≤ a handful of players →
    /// microseconds). `try_send` stays non-blocking, so a slow client never stalls the tick.
    fn broadcast_snapshot(
        &mut self,
        tick: u64,
        players: &[PlayerState],
        creatures: &[CreatureState],
        hearts: &[HeartDropState],
    ) {
        let periodic_keyframe = tick.is_multiple_of(KEYFRAME_INTERVAL_TICKS);
        // Build the spatial grid ONCE per tick from this tick's positions, so each receiver's AOI runs the
        // exact `in_view` test over only its 3×3-cell neighborhood (O(neighbors)) instead of every entity.
        let grids = AoiGrids::build(players, creatures, hearts);
        // The tick's entity state + the grids are READ-ONLY for the whole broadcast, and each receiver
        // touches only its OWN baseline + channel (disjoint per player, no cross-connection mutation). So
        // fan the per-connection AOI-filter + keyframe/delta encode + send across CPU cores with rayon:
        // pre-bind the shared read-only data into `&` locals (so the parallel closure borrows them, with no
        // `&self`/`&mut self.players` aliasing), then `par_iter_mut` over the players. The output bytes +
        // baseline updates are byte-identical to a sequential run — parallelism only reorders the
        // independent work, never the result. `try_send` stays non-blocking, so a slow client never stalls.
        let (grids, players, creatures, hearts) = (&grids, players, creatures, hearts);
        self.players.par_iter_mut().for_each(|(&id, receiver)| {
            let center = receiver_center(id, players);
            let view = aoi_view(
                id,
                center,
                &receiver.snapshot_baseline,
                grids,
                players,
                creatures,
                hearts,
            );

            let send_keyframe = periodic_keyframe || receiver.needs_keyframe;
            let bytes: Arc<[u8]> = if send_keyframe {
                encode_keyframe(tick, &view.players, &view.creatures, &view.hearts).into()
            } else {
                let baseline = &receiver.snapshot_baseline;
                encode_delta(
                    SnapshotView {
                        tick: baseline.tick,
                        players: &baseline.players,
                        creatures: &baseline.creatures,
                        hearts: &baseline.hearts,
                    },
                    SnapshotView {
                        tick,
                        players: &view.players,
                        creatures: &view.creatures,
                        hearts: &view.hearts,
                    },
                )
                .into()
            };

            let _ = receiver.conn.try_send(Outbound::Binary(bytes));
            receiver.needs_keyframe = false;
            receiver.snapshot_baseline = SnapshotBaseline {
                tick,
                players: view.players,
                creatures: view.creatures,
                hearts: view.hearts,
            };
        });
    }

    /// Fan a TRANSIENT spatial event (a swing / hit flash) out only to players whose AOI includes the event
    /// point — i.e. within `aoi::AOI_RADIUS` of `(center_x, center_z)` — skipping `except` (the actor, who
    /// already played it locally). A player who isn't near the point couldn't have seen the animation, so
    /// not receiving it has no world-state consequence; this keeps the high-volume Swing/Attack stream from
    /// fanning out to the whole room. Single-serialized like `broadcast`.
    fn broadcast_near(&self, center_x: f32, center_z: f32, except: PlayerId, msg: &ServerMsg) {
        let Some(frame) = serialize_frame(msg) else {
            return;
        };
        for p in self.players.values() {
            if p.id == except {
                continue;
            }
            if !crate::aoi::in_view((center_x, center_z), (p.x, p.z), false) {
                continue;
            }
            let _ = p.conn.try_send(Outbound::Frame(frame.clone()));
        }
    }

    /// Send one edit chunk's CURRENT edits to a connection as one or more `EditBatch` frames, and mark it
    /// loaded for the player so a later live Edit in that chunk reaches them. An empty chunk (nobody built
    /// there) is still marked loaded but sends nothing — its base terrain is procedural, so there is
    /// nothing to stream. Used by the join seed and the per-tick stream as the player moves.
    fn load_chunk_for(&mut self, id: PlayerId, chunk: (i32, i32)) {
        let edits = self.world.edits_in_chunk(chunk.0, chunk.1);
        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        if !p.loaded_chunks.insert(chunk) {
            return;
        }
        let conn = p.conn.clone();
        for batch in edits.chunks(BATCH_CHUNK_SIZE) {
            conn.send_one(ServerMsg::EditBatch {
                edits: batch
                    .iter()
                    .map(|&(x, y, z, block)| EditCell { x, y, z, id: block })
                    .collect(),
                by: 0,
            });
        }
    }

    /// The edit chunks within `LOAD_CHUNK_RADIUS` (Chebyshev) of the column `(x, z)`. The loaded square
    /// is sized to always cover the AOI reach, so every block a player could see lives in one of these.
    fn chunks_in_load_radius(x: f32, z: f32) -> Vec<(i32, i32)> {
        let (cx, cz) = sim::edit_chunk_of(x.floor() as i32, z.floor() as i32);
        let mut chunks = Vec::new();
        for dx in -LOAD_CHUNK_RADIUS..=LOAD_CHUNK_RADIUS {
            for dz in -LOAD_CHUNK_RADIUS..=LOAD_CHUNK_RADIUS {
                chunks.push((cx + dx, cz + dz));
            }
        }
        chunks
    }

    /// Stream every edit chunk now within a player's load radius that they have NOT already received,
    /// sending each chunk's current edits once and marking it loaded. Loaded chunks are never unloaded:
    /// the edit map is sparse and base terrain is procedural, so re-entry costs nothing and keeping them
    /// guarantees a player who re-enters never has to re-receive — and never misses an interim edit.
    fn stream_chunks(&mut self, id: PlayerId) {
        let Some(p) = self.players.get(&id) else {
            return;
        };
        let new_chunks: Vec<(i32, i32)> = Self::chunks_in_load_radius(p.x, p.z)
            .into_iter()
            .filter(|chunk| !p.loaded_chunks.contains(chunk))
            .collect();
        for chunk in new_chunks {
            self.load_chunk_for(id, chunk);
        }
    }

    /// Fan a live block Edit out only to the players who have its edit chunk loaded — i.e. who already
    /// hold that chunk's full state and so can correctly apply the delta. A player without the chunk
    /// loaded is intentionally NOT sent the live edit: when they later move into the chunk they receive
    /// its CURRENT state (which already folds this edit in) via the per-tick stream, so they always
    /// converge to the correct block state regardless of edits made while they were away.
    fn broadcast_edit_in_chunk(&self, chunk: (i32, i32), msg: &ServerMsg) {
        let Some(frame) = serialize_frame(msg) else {
            return;
        };
        for p in self.players.values() {
            if !p.loaded_chunks.contains(&chunk) {
                continue;
            }
            let _ = p.conn.try_send(Outbound::Frame(frame.clone()));
        }
    }

    /// Fan a live EditBatch (a placed structure) out per chunk: group its cells by edit chunk and send
    /// each chunk's cells only to the players who have THAT chunk loaded. A structure may straddle a
    /// chunk boundary, so a player holding one of its chunks but not the other gets exactly the cells in
    /// the chunk they hold; the rest reach them via the stream when they enter the other chunk.
    fn broadcast_edit_batch_by_chunk(&self, edits: &[EditCell], by: PlayerId) {
        let mut by_chunk: HashMap<(i32, i32), Vec<EditCell>> = HashMap::new();
        for &cell in edits {
            by_chunk
                .entry(sim::edit_chunk_of(cell.x, cell.z))
                .or_default()
                .push(cell);
        }
        for (chunk, cells) in by_chunk {
            self.broadcast_edit_in_chunk(chunk, &ServerMsg::EditBatch { edits: cells, by });
        }
    }

    /// Keep a capped creature population near active players and advance each one. Despawn creatures
    /// no player is close to; spawn up to the cap around a random player on a slow cadence.
    fn simulate_creatures(&mut self, dt: f32) {
        // A slot held for reconnect (avatar frozen) is invisible to the creatures: it neither anchors the
        // population nor draws bites, so a player mid-blip isn't swarmed or hurt while away.
        let player_xz: Vec<[f32; 2]> = self
            .players
            .values()
            .filter(|p| p.disconnected_at.is_none())
            .map(|p| [p.x, p.z])
            .collect();
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
            if p.disconnected_at.is_some() {
                continue;
            }
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
        // Stress affordance: STRESS_SPAWN_RADIUS scatters spawns across a wide area so a load test can
        // place players far enough apart for AOI to engage. Unset/too-small → the normal spawn ring.
        let spawn_radius = std::env::var("STRESS_SPAWN_RADIUS")
            .ok()
            .and_then(|v| v.parse::<i32>().ok())
            .filter(|r| *r > sim::SPAWN_AREA_RADIUS)
            .unwrap_or(sim::SPAWN_AREA_RADIUS);
        let (base_x, base_z) =
            sim::random_spawn_base_with_radius(rng.gen(), rng.gen(), spawn_radius);
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
        // AOI-filtered: only players who have this block's chunk loaded get the live break.
        self.broadcast_edit_in_chunk(
            sim::edit_chunk_of(x, z),
            &ServerMsg::Edit {
                x,
                y,
                z,
                id: sim::AIR,
                by: id,
            },
        );
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
        let (creature_x, creature_z) = (self.creatures[index].pos[0], self.creatures[index].pos[2]);
        self.creatures[index].hp = self.creatures[index].hp.saturating_sub(1);
        // The nearby players who could see the creature get the same flash on it (the attacker plays it locally).
        self.broadcast_near(
            creature_x,
            creature_z,
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
                ping_ms: p.ping.load(Ordering::Relaxed),
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

/// One connection's AOI-filtered view of the world this tick: its own entities to encode, owned so the
/// borrow of the room's player map can end before they become that connection's next baseline.
struct AoiView {
    players: Vec<PlayerState>,
    creatures: Vec<CreatureState>,
    hearts: Vec<HeartDropState>,
}

/// The receiving player's own horizontal `(x, z)` center, read from this tick's player states (the AOI
/// radii are measured from it). The receiver is always present in `players` (their snapshot is built from
/// the same map), so a miss can only mean a logic error — fall back to the origin rather than panic.
fn receiver_center(receiver_id: PlayerId, players: &[PlayerState]) -> (f32, f32) {
    match players.iter().find(|p| p.0 == receiver_id) {
        Some(p) => (p.1, p.3),
        None => (0.0, 0.0),
    }
}

/// The per-tick spatial grids (one per entity kind, since their ids share the `u32` namespace), built
/// once from this tick's positions so each receiver's AOI candidate set is its 3×3-cell neighborhood.
struct AoiGrids {
    players: SpatialGrid,
    creatures: SpatialGrid,
    hearts: SpatialGrid,
}

impl AoiGrids {
    fn build(
        players: &[PlayerState],
        creatures: &[CreatureState],
        hearts: &[HeartDropState],
    ) -> Self {
        let mut grids = Self {
            players: SpatialGrid::new(),
            creatures: SpatialGrid::new(),
            hearts: SpatialGrid::new(),
        };
        players
            .iter()
            .for_each(|p| grids.players.insert(p.0, p.1, p.3));
        creatures
            .iter()
            .for_each(|c| grids.creatures.insert(c.0, c.2, c.4));
        hearts
            .iter()
            .for_each(|h| grids.hearts.insert(h.0, h.1, h.3));
        grids
    }
}

/// The candidate ids the AOI test must evaluate for one receiver and one entity kind: the grid's 3×3
/// neighborhood around the receiver UNION the ids in its previous baseline. A sticky entity that drifted
/// out of the neighborhood since last tick must still be re-evaluated for the hysteresis upper bound, so a
/// baseline id is always a candidate even when the grid no longer lists it near the receiver.
fn aoi_candidates(
    near: Vec<u32>,
    baseline_ids: impl Iterator<Item = u32>,
) -> std::collections::HashSet<u32> {
    let mut candidates: std::collections::HashSet<u32> = near.into_iter().collect();
    candidates.extend(baseline_ids);
    candidates
}

/// Build `receiver_id`'s AOI view: their OWN player record ALWAYS (self-reconciliation is never culled),
/// plus every other player/creature/heart within the receiver's interest radius. The candidate set is the
/// receiver's grid neighborhood plus its previous baseline; hysteresis is applied per entity from whether
/// it was in that baseline, so an entity already in view leaves only once it passes `AOI_RADIUS + AOI_HYSTERESIS`.
fn aoi_view(
    receiver_id: PlayerId,
    center: (f32, f32),
    baseline: &SnapshotBaseline,
    grids: &AoiGrids,
    players: &[PlayerState],
    creatures: &[CreatureState],
    hearts: &[HeartDropState],
) -> AoiView {
    let player_candidates = aoi_candidates(
        grids.players.near(center.0, center.1),
        baseline.players.iter().map(|b| b.0),
    );
    let kept_players = players
        .iter()
        .filter(|p| {
            p.0 == receiver_id
                || (player_candidates.contains(&p.0)
                    && crate::aoi::in_view(
                        center,
                        (p.1, p.3),
                        baseline.players.iter().any(|b| b.0 == p.0),
                    ))
        })
        .cloned()
        .collect();
    let creature_candidates = aoi_candidates(
        grids.creatures.near(center.0, center.1),
        baseline.creatures.iter().map(|b| b.0),
    );
    let kept_creatures = creatures
        .iter()
        .filter(|c| {
            creature_candidates.contains(&c.0)
                && crate::aoi::in_view(
                    center,
                    (c.2, c.4),
                    baseline.creatures.iter().any(|b| b.0 == c.0),
                )
        })
        .cloned()
        .collect();
    let heart_candidates = aoi_candidates(
        grids.hearts.near(center.0, center.1),
        baseline.hearts.iter().map(|b| b.0),
    );
    let kept_hearts = hearts
        .iter()
        .filter(|h| {
            heart_candidates.contains(&h.0)
                && crate::aoi::in_view(
                    center,
                    (h.1, h.3),
                    baseline.hearts.iter().any(|b| b.0 == h.0),
                )
        })
        .cloned()
        .collect();
    AoiView {
        players: kept_players,
        creatures: kept_creatures,
        hearts: kept_hearts,
    }
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
    use crate::aoi;
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
            Outbound::Binary(_) => {
                panic!("binary frames carry the snapshot only; assert on its bytes via broadcast_snapshot")
            }
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
            ping: Arc::new(AtomicU32::new(0)),
            score: 0,
            pvp_kills: 0,
            conn,
            needs_keyframe: true,
            snapshot_baseline: SnapshotBaseline::default(),
            disconnected_at: None,
            last_seen: now,
            last_move: now,
            move_synced: false,
            hp: MAX_HP,
            hurt_at: now,
            // Seed the loaded set the way a real join does (the chunks around the player's spawn column),
            // so a test player at the origin already holds chunk (0,0) and receives live edits there.
            loaded_chunks: Room::chunks_in_load_radius(0.0, 0.0).into_iter().collect(),
            dig_block: None,
            dig_hits: 0,
            last_action: now - ATTACK_MIN_INTERVAL,
            playtime_key: format!("acc{id}"),
            playtime_baseline_ms: 0,
            playtime_persisted_ms: 0,
            inventory: HashMap::new(),
            infinite: true,
            joined_at_ms: 0,
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
    async fn pvp_kill_credits_the_attacker_and_respawns_the_victim() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        let mut target_rx = add_player(&mut room, 2, false);
        room.pvp = true;
        // Both at the origin (within MELEE_RANGE); the victim is one hit from death.
        room.players.get_mut(&2).unwrap().hp = 1;
        room.on_attack_player(1, 2);
        assert_eq!(
            room.players.get(&1).unwrap().pvp_kills,
            1,
            "the killer's pvp-kill count rises by one"
        );
        assert_eq!(
            room.players.get(&2).unwrap().hp,
            MAX_HP,
            "the victim respawns at full health"
        );
        assert!(
            (0..50)
                .filter_map(|_| target_rx.try_recv_msg().ok())
                .any(|m| matches!(m, ServerMsg::Respawn { hp, .. } if hp == MAX_HP)),
            "the victim is told to respawn",
        );
    }

    #[tokio::test]
    async fn a_non_lethal_pvp_hit_does_not_credit_a_kill() {
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        add_player(&mut room, 2, false);
        room.pvp = true;
        // The victim has hearts to spare, so the hit hurts but does not kill.
        room.on_attack_player(1, 2);
        assert_eq!(
            room.players.get(&1).unwrap().pvp_kills,
            0,
            "no kill is credited while the victim survives",
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

    fn received_swing(rx: &mut mpsc::Receiver<Outbound>) -> bool {
        std::iter::from_fn(|| rx.try_recv_msg().ok()).any(|m| matches!(m, ServerMsg::Swing { .. }))
    }

    #[tokio::test]
    async fn broadcast_near_reaches_an_in_range_player_and_not_a_far_one_nor_the_except() {
        let mut room = test_room().await;
        let mut except_rx = add_player_at(&mut room, 1, 0.0, 0.0); // the actor (excepted)
        let mut near_rx = add_player_at(&mut room, 2, 10.0, 10.0); // within AOI of the event point
        let mut far_rx = add_player_at(&mut room, 3, 50_000.0, 0.0); // way outside AOI

        room.broadcast_near(0.0, 0.0, 1, &ServerMsg::Swing { id: 1 });

        assert!(received_swing(&mut near_rx), "the in-range player gets it");
        assert!(!received_swing(&mut far_rx), "the far player does not");
        assert!(
            !received_swing(&mut except_rx),
            "the excepted actor does not"
        );
    }

    #[tokio::test]
    async fn a_swing_near_player_a_reaches_a_but_not_far_player_b() {
        let mut room = test_room().await;
        let mut a_rx = add_player_at(&mut room, 2, 5.0, 5.0); // near the actor
        let mut b_rx = add_player_at(&mut room, 3, 50_000.0, 0.0); // far away
        add_player_at(&mut room, 1, 0.0, 0.0); // the acting player

        assert!(room.accept_primary_action(1, Instant::now()));

        assert!(received_swing(&mut a_rx), "A near the actor sees the swing");
        assert!(!received_swing(&mut b_rx), "B 50000 away does not");
    }

    /// Every edit cell a connection received across all EditBatch/Edit frames it got, as a flat set —
    /// the chunk-streaming tests assert on which built blocks reached a player.
    fn received_edits(rx: &mut mpsc::Receiver<Outbound>) -> Vec<(i32, i32, i32, u8)> {
        let mut out = Vec::new();
        while let Ok(msg) = rx.try_recv_msg() {
            match msg {
                ServerMsg::EditBatch { edits, .. } => {
                    out.extend(edits.into_iter().map(|c| (c.x, c.y, c.z, c.id)))
                }
                ServerMsg::Edit { x, y, z, id, .. } => out.push((x, y, z, id)),
                _ => {}
            }
        }
        out
    }

    /// Insert a player WITHOUT seeding any loaded chunks (a fresh slot the join stream will populate), at
    /// the given position. Used by the streaming tests so they exercise `stream_chunks` from empty.
    fn add_unloaded_player_at(
        room: &mut Room,
        id: PlayerId,
        x: f32,
        z: f32,
    ) -> mpsc::Receiver<Outbound> {
        let rx = add_player(room, id, false);
        let p = room.players.get_mut(&id).unwrap();
        p.x = x;
        p.z = z;
        p.loaded_chunks.clear();
        rx
    }

    #[tokio::test]
    async fn stream_chunks_sends_only_near_chunks_not_the_whole_world() {
        let mut room = test_room().await;
        // A far structure outside the player's load radius, and a near one inside it.
        let near = (50, 8, 60, sim::STONE);
        let far_x = sim::EDIT_CHUNK_SIZE * (LOAD_CHUNK_RADIUS + 3);
        let far = (far_x, 8, 0, sim::GOLD);
        room.world.set(near.0, near.1, near.2, near.3);
        room.world.set(far.0, far.1, far.2, far.3);

        let mut rx = add_unloaded_player_at(&mut room, 1, 64.0, 64.0);
        room.stream_chunks(1);

        let got = received_edits(&mut rx);
        assert!(
            got.contains(&near),
            "the near structure is streamed on join"
        );
        assert!(
            !got.contains(&far),
            "a structure beyond the load radius is NOT streamed"
        );
    }

    #[tokio::test]
    async fn moving_into_a_new_chunk_streams_it_once_and_marks_it_loaded() {
        let mut room = test_room().await;
        // A built block far enough that the origin player does not initially load its chunk.
        let far_x = sim::EDIT_CHUNK_SIZE * (LOAD_CHUNK_RADIUS + 2);
        let built = (far_x, 8, 0, sim::WOOD);
        room.world.set(built.0, built.1, built.2, built.3);

        let mut rx = add_unloaded_player_at(&mut room, 1, 0.0, 0.0);
        room.stream_chunks(1);
        assert!(
            !received_edits(&mut rx).contains(&built),
            "the far chunk is not loaded from the origin"
        );

        // Walk next to the built block; its chunk now enters the load radius and is streamed once.
        room.players.get_mut(&1).unwrap().x = far_x as f32;
        room.stream_chunks(1);
        assert!(
            received_edits(&mut rx).contains(&built),
            "entering the chunk streams its edits"
        );
        let chunk = sim::edit_chunk_of(far_x, 0);
        assert!(
            room.players.get(&1).unwrap().loaded_chunks.contains(&chunk),
            "the entered chunk is marked loaded"
        );

        // Staying in the chunk does not re-send it.
        room.stream_chunks(1);
        assert!(
            received_edits(&mut rx).is_empty(),
            "an already-loaded chunk is never re-streamed while staying in it"
        );
    }

    #[tokio::test]
    async fn a_live_edit_reaches_an_in_range_player_and_not_a_far_one() {
        let mut room = test_room().await;
        // Near player loads the edit's chunk on join; far player is many chunks away.
        let mut near_rx = add_unloaded_player_at(&mut room, 1, 10.0, 10.0);
        let far_x = sim::EDIT_CHUNK_SIZE as f32 * (LOAD_CHUNK_RADIUS + 5) as f32;
        let mut far_rx = add_unloaded_player_at(&mut room, 2, far_x, 0.0);
        room.stream_chunks(1);
        room.stream_chunks(2);
        let _ = received_edits(&mut near_rx);
        let _ = received_edits(&mut far_rx);

        // A third player places a block in the near player's chunk (id 3 at the same spot, infinite).
        let mut placer_rx = add_unloaded_player_at(&mut room, 3, 11.0, 10.0);
        room.stream_chunks(3);
        let _ = received_edits(&mut placer_rx);
        room.players.get_mut(&3).unwrap().y = 12.0;
        room.on_input(
            3,
            ClientMsg::Edit {
                op: EditOp::Place,
                x: 11,
                y: 12,
                z: 10,
                id: sim::STONE,
            },
        );

        assert!(
            received_edits(&mut near_rx).contains(&(11, 12, 10, sim::STONE)),
            "the in-range player receives the live edit"
        );
        assert!(
            !received_edits(&mut far_rx).contains(&(11, 12, 10, sim::STONE)),
            "the far player does NOT receive the live edit"
        );
    }

    #[tokio::test]
    async fn a_far_player_who_enters_a_chunk_edited_while_away_ends_with_the_correct_state() {
        // The CONSISTENCY INVARIANT: a player who was nowhere near an edit, made while they were out of
        // range, still ends up with the correct current block state when they later move into the chunk.
        let mut room = test_room().await;
        let mut away_rx = add_unloaded_player_at(&mut room, 1, 0.0, 0.0);
        let edit_x = sim::EDIT_CHUNK_SIZE * (LOAD_CHUNK_RADIUS + 4);
        let chunk = sim::edit_chunk_of(edit_x, 0);
        room.stream_chunks(1);
        let _ = received_edits(&mut away_rx);
        assert!(
            !room.players.get(&1).unwrap().loaded_chunks.contains(&chunk),
            "the chunk starts unloaded for the away player"
        );

        // Someone edits that far chunk while player 1 is away (player 1 is NOT sent the live edit).
        let mut editor_rx = add_unloaded_player_at(&mut room, 2, edit_x as f32, 0.0);
        room.stream_chunks(2);
        let _ = received_edits(&mut editor_rx);
        room.players.get_mut(&2).unwrap().y = 12.0;
        room.on_input(
            2,
            ClientMsg::Edit {
                op: EditOp::Place,
                x: edit_x,
                y: 12,
                z: 0,
                id: sim::GOLD,
            },
        );
        assert!(
            !received_edits(&mut away_rx).contains(&(edit_x, 12, 0, sim::GOLD)),
            "the away player did not get the live edit (its chunk was unloaded)"
        );

        // Player 1 now walks into that chunk: the stream hands them its CURRENT state, edit included.
        room.players.get_mut(&1).unwrap().x = edit_x as f32;
        room.stream_chunks(1);
        assert!(
            received_edits(&mut away_rx).contains(&(edit_x, 12, 0, sim::GOLD)),
            "entering the chunk delivers the edit made while away"
        );
        assert_eq!(
            room.world.get(edit_x, 12, 0),
            sim::GOLD,
            "the authoritative world holds the edit, and the player now mirrors it"
        );
    }

    #[tokio::test]
    async fn a_creature_hit_flash_reaches_a_near_player_but_not_a_far_one() {
        let mut room = test_room().await;
        let mut a_rx = add_player_at(&mut room, 2, 5.0, 5.0); // near the attacker + creature
        let mut b_rx = add_player_at(&mut room, 3, 50_000.0, 0.0); // far away
        add_player_at(&mut room, 1, 0.0, 0.0); // the attacker
        room.creatures.push(Creature::spawn(
            10,
            CreatureKind::ALL[0],
            1.0,
            1.0,
            |_, _| 0,
        ));

        room.on_hit(1, 10);

        let near_flash = std::iter::from_fn(|| a_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Attack { id: 10, .. }));
        let far_flash = std::iter::from_fn(|| b_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Attack { .. }));
        assert!(near_flash, "the near player sees the creature flash");
        assert!(!far_flash, "the far player does not");
    }

    #[tokio::test]
    async fn a_pvp_hit_flash_reaches_a_near_player_but_not_a_far_one() {
        let mut room = test_room().await;
        room.pvp = true;
        let mut a_rx = add_player_at(&mut room, 3, 5.0, 5.0); // near the target
        let mut b_rx = add_player_at(&mut room, 4, 50_000.0, 0.0); // far away
        add_player_at(&mut room, 1, 0.0, 0.0); // the attacker
        add_player_at(&mut room, 2, 1.0, 1.0); // the target (within melee range of the attacker)

        room.on_attack_player(1, 2);

        let near_flash = std::iter::from_fn(|| a_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Attack { id: 2, .. }));
        let far_flash = std::iter::from_fn(|| b_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Attack { .. }));
        assert!(near_flash, "the near player sees the pvp flash");
        assert!(!far_flash, "the far player does not");
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
        room.players.get_mut(&2).unwrap().pvp_kills = 4;
        room.players.get_mut(&2).unwrap().inventory.insert(1, 3);
        room.on_admin_reset_scores(1);
        assert_eq!(room.players.get(&1).unwrap().score, 0);
        assert_eq!(room.players.get(&2).unwrap().score, 0);
        assert_eq!(
            room.players.get(&2).unwrap().pvp_kills,
            0,
            "the pvp-kill count is wiped too",
        );
        assert_eq!(
            room.players.get(&2).unwrap().inventory.get(&1),
            Some(&3),
            "the banked inventory is never touched by a score reset",
        );
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
    async fn a_moderator_cannot_kick_an_admin_but_an_admin_can_kick_anyone() {
        // A helper (moderator) may kick ordinary players, but never a parent (admin). An admin can still
        // kick anyone, including a moderator.
        let mut room = test_room().await;
        let _moderator_rx = add_player(&mut room, 1, false);
        room.players.get_mut(&1).unwrap().is_moderator = true;
        let _admin_rx = add_player(&mut room, 2, true);
        let _player_rx = add_player(&mut room, 3, false);

        room.on_input(1, ClientMsg::AdminKick { id: 2 });
        assert!(
            room.players.contains_key(&2),
            "a moderator cannot kick an admin"
        );

        room.on_input(1, ClientMsg::AdminKick { id: 3 });
        assert!(
            !room.players.contains_key(&3),
            "a moderator can still kick a normal player"
        );

        room.on_input(2, ClientMsg::AdminKick { id: 1 });
        assert!(
            !room.players.contains_key(&1),
            "an admin can kick a moderator"
        );
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
        // The single-serialize win for JSON fan-out messages (events, roster, …): the room must encode a
        // fan-out message ONCE and send the same shared frame to every connection, byte-for-byte what the
        // old per-connection `serde_json::to_string(&msg)` produced — same wire format, encoded one time.
        let mut room = test_room().await;
        let mut rx_a = add_player(&mut room, 1, false);
        let mut rx_b = add_player(&mut room, 2, false);
        let msg = ServerMsg::Left { id: 9 };
        let expected = serde_json::to_string(&msg).unwrap();
        room.broadcast(&msg);

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
    async fn fresh_players_get_a_per_connection_keyframe_then_delta() {
        // Two just-added connections each need a baseline, so each gets a KEYFRAME of ITS OWN AOI view —
        // encoded per connection now (AOI makes every player's content differ, so the single-serialize win
        // is intentionally traded away). Both players sit at the origin and the only entities are within
        // their interest radius, so the two views are byte-identical content even though each Arc is its
        // own encode. The next tick, both are in-sync and get a per-connection DELTA against THEIR baseline.
        let mut room = test_room().await;
        let mut rx_a = add_player(&mut room, 1, false);
        let mut rx_b = add_player(&mut room, 2, false);
        // Both players are in the states this tick (the receiver's own record is always present).
        let players = vec![
            PlayerState(1, 1.0, 2.0, 3.0, 0.5, 0.1, 20, 4, 3),
            PlayerState(2, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
        ];
        let creatures = vec![CreatureState(50, 4, -3.0, 63.5, 8.0, 0.2, 2, 2)];
        let hearts = vec![HeartDropState(200, -5.0, 63.5, 0.0)];
        let expected_keyframe = encode_keyframe(7, &players, &creatures, &hearts);
        room.broadcast_snapshot(7, &players, &creatures, &hearts);

        let Outbound::Binary(key_a) = rx_a.try_recv().unwrap() else {
            panic!("a fresh player must get a Binary keyframe");
        };
        let Outbound::Binary(key_b) = rx_b.try_recv().unwrap() else {
            panic!("a fresh player must get a Binary keyframe");
        };
        assert_eq!(
            &*key_a,
            expected_keyframe.as_slice(),
            "the first frame is a keyframe of the full (in-range) view"
        );
        assert_eq!(
            key_a, key_b,
            "both views are byte-identical content (everyone in range)"
        );
        assert!(
            !Arc::ptr_eq(&key_a, &key_b),
            "but each connection is encoded on its own — no shared Arc under AOI"
        );

        // Next tick: both are in-sync, so each gets a per-connection delta against ITS OWN baseline.
        let moved = vec![
            PlayerState(1, 2.0, 2.0, 3.0, 0.5, 0.1, 20, 4, 3),
            PlayerState(2, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
        ];
        let expected_delta = encode_delta(
            SnapshotView {
                tick: 7,
                players: &players,
                creatures: &creatures,
                hearts: &hearts,
            },
            SnapshotView {
                tick: 8,
                players: &moved,
                creatures: &creatures,
                hearts: &hearts,
            },
        );
        room.broadcast_snapshot(8, &moved, &creatures, &hearts);

        let Outbound::Binary(delta_a) = rx_a.try_recv().unwrap() else {
            panic!("an in-sync player must get a Binary delta");
        };
        let Outbound::Binary(delta_b) = rx_b.try_recv().unwrap() else {
            panic!("an in-sync player must get a Binary delta");
        };
        assert_eq!(
            &*delta_a,
            expected_delta.as_slice(),
            "the follow-up frame is a delta against the connection's own baseline"
        );
        assert_eq!(delta_a, delta_b, "identical content, both in range");
        assert!(
            !Arc::ptr_eq(&delta_a, &delta_b),
            "each delta is encoded per connection under AOI"
        );
    }

    #[tokio::test]
    async fn a_resumed_connection_gets_a_keyframe_not_a_delta_it_cannot_apply() {
        // A player that was in-sync, dropped, and reconnected has a fresh socket with no baseline. Mark it
        // needs_keyframe (as try_resume does) and assert the next snapshot is a KEYFRAME, not a delta.
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        let players = vec![PlayerState(1, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3)];
        room.broadcast_snapshot(7, &players, &[], &[]);
        let _ = rx.try_recv(); // drain the join keyframe

        // In-sync now; a normal delta would follow. Simulate a resume re-flagging needs_keyframe.
        room.players.get_mut(&1).unwrap().needs_keyframe = true;
        room.broadcast_snapshot(8, &players, &[], &[]);
        let Outbound::Binary(bytes) = rx.try_recv().unwrap() else {
            panic!("the resumed connection must get a Binary frame");
        };
        assert_eq!(
            bytes[1],
            protocol::snapshot_codec::FRAME_KEYFRAME,
            "a resume gets a keyframe"
        );
    }

    #[tokio::test]
    async fn a_periodic_keyframe_is_emitted_on_the_interval() {
        // Every KEYFRAME_INTERVAL_TICKS the room sends a full keyframe to in-sync clients to bound the
        // baseline and let any desynced client resync; the ticks between are deltas.
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        let players = vec![PlayerState(1, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3)];
        room.broadcast_snapshot(1, &players, &[], &[]); // join keyframe
        let _ = rx.try_recv();

        room.broadcast_snapshot(2, &players, &[], &[]); // in-sync -> delta
        let Outbound::Binary(d) = rx.try_recv().unwrap() else {
            panic!("expected a binary frame");
        };
        assert_eq!(d[1], protocol::snapshot_codec::FRAME_DELTA);

        room.broadcast_snapshot(KEYFRAME_INTERVAL_TICKS, &players, &[], &[]); // on the interval -> keyframe
        let Outbound::Binary(k) = rx.try_recv().unwrap() else {
            panic!("expected a binary frame");
        };
        assert_eq!(k[1], protocol::snapshot_codec::FRAME_KEYFRAME);
    }

    /// The entity ids a KEYFRAME frame carries, in (players, creatures, hearts). Used by the AOI tests to
    /// assert exactly which entities reached a given connection. Only the counts + ids are read; the record
    /// bodies are skipped at their fixed widths (player 33, creature 23, heart 16 bytes — id is the first 4).
    fn keyframe_ids(bytes: &[u8]) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
        assert_eq!(
            bytes[1],
            protocol::snapshot_codec::FRAME_KEYFRAME,
            "keyframe"
        );
        let mut offset = 10usize; // version(1) + kind(1) + tick(8)
        let read_u16 = |b: &[u8], o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as usize;
        let read_u32 =
            |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let mut ids = |record_width: usize| {
            let count = read_u16(bytes, offset);
            offset += 2;
            (0..count)
                .map(|_| {
                    let id = read_u32(bytes, offset);
                    offset += record_width;
                    id
                })
                .collect::<Vec<u32>>()
        };
        (ids(33), ids(23), ids(16))
    }

    /// Add a player and place them at a horizontal `(x, z)`, returning the channel that captures their
    /// frames. Mirrors how the AOI tests spread players across the huge world.
    fn add_player_at(room: &mut Room, id: PlayerId, x: f32, z: f32) -> mpsc::Receiver<Outbound> {
        let rx = add_player(room, id, false);
        let p = room.players.get_mut(&id).unwrap();
        p.x = x;
        p.z = z;
        // Reseed the loaded set to the actual position so a spread-out player holds its own chunks, not
        // the origin's (the edit-broadcast tests rely on a far player NOT having a near chunk loaded).
        p.loaded_chunks = Room::chunks_in_load_radius(x, z).into_iter().collect();
        rx
    }

    /// The per-tick state arrays the tick loop builds, here assembled straight from the room's players plus
    /// the given creatures/hearts, so an AOI test snapshots the same shapes `broadcast_snapshot` consumes.
    fn states_of(room: &Room) -> Vec<PlayerState> {
        room.players
            .values()
            .map(|p| {
                PlayerState(
                    p.id,
                    p.x,
                    p.y,
                    p.z,
                    p.yaw,
                    p.pitch,
                    p.ping.load(Ordering::Relaxed),
                    p.score,
                    p.hp,
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn snapshot_carries_the_connection_measured_ping_from_the_atomic() {
        // The connection task owns the ping atomic; the room only reads it into the snapshot. Storing a
        // value into a player's shared atomic must surface verbatim in the per-tick PlayerState.
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        room.players
            .get(&1)
            .unwrap()
            .ping
            .store(73, Ordering::Relaxed);
        let states = states_of(&room);
        assert_eq!(states[0].6, 73, "the snapshot reads ping from the atomic");
    }

    #[tokio::test]
    async fn a_busy_late_tick_never_changes_the_measured_ping() {
        // Ping is now measured on the connection task, so the room tick must NOT touch it: even running many
        // ticks (a stand-in for a slow, overloaded room) leaves the connection-measured value untouched.
        let mut room = test_room().await;
        add_player(&mut room, 1, false);
        // Make this a guest so the periodic reclaim sweep (which kicks an account whose claim isn't live)
        // never removes it across the long tick run; the ping assertion is what this test is about.
        let guest = room.players.get_mut(&1).unwrap();
        guest.account_id = String::new();
        guest.claim = String::new();
        let ping = room.players.get(&1).unwrap().ping.clone();
        ping.store(42, Ordering::Relaxed);
        for _ in 0..200 {
            room.tick(0.05);
        }
        assert_eq!(
            ping.load(Ordering::Relaxed),
            42,
            "the tick leaves the connection-measured ping untouched"
        );
        assert_eq!(
            states_of(&room)[0].6,
            42,
            "and the snapshot still reflects exactly the measured ping"
        );
    }

    #[tokio::test]
    async fn two_far_players_each_see_only_their_local_entities() {
        // Players A and B are 50000 units apart in the huge world. A creature sits next to A. A's frame must
        // carry A's own record + the near creature and NOT B (nor far entities); B's frame must carry B's own
        // record and NOT A nor A's creature. This is the core AOI property: each client gets "what's around me".
        let mut room = test_room().await;
        let mut rx_a = add_player_at(&mut room, 1, 0.0, 0.0);
        let mut rx_b = add_player_at(&mut room, 2, 50_000.0, 0.0);
        let players = states_of(&room);
        let creatures = vec![
            CreatureState(10, 0, 5.0, 64.0, 5.0, 0.0, 2, 2), // next to A
            CreatureState(11, 0, 50_005.0, 64.0, 0.0, 0.0, 2, 2), // next to B
        ];
        room.broadcast_snapshot(7, &players, &creatures, &[]);

        let Outbound::Binary(frame_a) = rx_a.try_recv().unwrap() else {
            panic!("A must get a Binary keyframe");
        };
        let Outbound::Binary(frame_b) = rx_b.try_recv().unwrap() else {
            panic!("B must get a Binary keyframe");
        };
        let (players_a, creatures_a, _) = keyframe_ids(&frame_a);
        let (players_b, creatures_b, _) = keyframe_ids(&frame_b);
        assert_eq!(players_a, vec![1], "A sees only itself, not the distant B");
        assert_eq!(creatures_a, vec![10], "A sees only its local creature");
        assert_eq!(players_b, vec![2], "B sees only itself, not the distant A");
        assert_eq!(creatures_b, vec![11], "B sees only its local creature");
    }

    #[tokio::test]
    async fn a_baseline_creature_well_outside_the_grid_neighborhood_is_re_evaluated_and_dropped() {
        // The grid-accelerated AOI must still include a receiver's previous-baseline ids as candidates so a
        // sticky entity is re-evaluated for the hysteresis upper bound even after it drifts out of the 3×3
        // cell block. Here a creature is in view, then teleports far past the band: it must LEAVE as a delta
        // removal (the grid no longer lists it near the receiver, but the baseline-union still re-evaluates it).
        let mut room = test_room().await;
        let mut rx = add_player_at(&mut room, 1, 0.0, 0.0);
        let mut creature = vec![CreatureState(10, 0, 5.0, 64.0, 0.0, 0.0, 2, 2)]; // next to A -> in view

        let players = states_of(&room);
        room.broadcast_snapshot(1, &players, &creature, &[]);
        let Outbound::Binary(k) = rx.try_recv().unwrap() else {
            panic!("keyframe");
        };
        assert_eq!(keyframe_ids(&k).1, vec![10], "creature starts in view");

        // It jumps far outside both the AOI band and the receiver's 3×3 grid neighborhood.
        creature[0].2 = 50_000.0;
        let players = states_of(&room);
        room.broadcast_snapshot(2, &players, &creature, &[]);
        let Outbound::Binary(d) = rx.try_recv().unwrap() else {
            panic!("delta");
        };
        assert_eq!(
            delta_removed_creature_ids(&d),
            vec![10],
            "a baseline entity that left the neighborhood is re-evaluated and removed",
        );
    }

    #[tokio::test]
    async fn a_creature_enters_then_leaves_a_players_delta_as_it_moves() {
        // A starts far from a creature (out of AOI), then walks toward it (it ENTERS as an added record),
        // then walks away past the hysteresis upper bound (it LEAVES as a removed id). Proves AOI changes
        // surface to the client as ordinary delta adds/removes — exactly the despawn/spawn coop.rs handles.
        let mut room = test_room().await;
        let mut rx = add_player_at(&mut room, 1, 0.0, 0.0);
        let creature_x = aoi::AOI_RADIUS + 100.0; // out of view from the origin
        let creature = vec![CreatureState(10, 0, creature_x, 64.0, 0.0, 0.0, 2, 2)];

        // Tick 1: keyframe (fresh). The creature is out of range, so it is absent.
        let players = states_of(&room);
        room.broadcast_snapshot(1, &players, &creature, &[]);
        let Outbound::Binary(k) = rx.try_recv().unwrap() else {
            panic!("keyframe");
        };
        assert!(keyframe_ids(&k).1.is_empty(), "creature starts out of AOI");

        // Tick 2: A walks to within the radius -> the creature ENTERS as a delta add.
        room.players.get_mut(&1).unwrap().x = creature_x - (aoi::AOI_RADIUS - 10.0);
        let players = states_of(&room);
        room.broadcast_snapshot(2, &players, &creature, &[]);
        let Outbound::Binary(d) = rx.try_recv().unwrap() else {
            panic!("delta");
        };
        assert_eq!(d[1], protocol::snapshot_codec::FRAME_DELTA);
        assert_eq!(
            delta_changed_creature_ids(&d),
            vec![10],
            "the creature enters as an added record"
        );

        // Tick 3: A walks back well past the hysteresis upper bound -> the creature LEAVES as a removed id.
        room.players.get_mut(&1).unwrap().x = 0.0;
        let players = states_of(&room);
        room.broadcast_snapshot(3, &players, &creature, &[]);
        let Outbound::Binary(d) = rx.try_recv().unwrap() else {
            panic!("delta");
        };
        assert_eq!(
            delta_removed_creature_ids(&d),
            vec![10],
            "past the hysteresis bound the creature leaves as a removed id"
        );
    }

    #[tokio::test]
    async fn the_hysteresis_band_keeps_an_in_view_creature_sticky() {
        // A creature sits inside the hysteresis band (between AOI_RADIUS and AOI_RADIUS + AOI_HYSTERESIS).
        // Once A has it in view (it entered while closer), backing off into the band must NOT drop it: the
        // delta has no change for it. Only crossing the upper bound removes it (covered by the test above).
        let mut room = test_room().await;
        let mut rx = add_player_at(&mut room, 1, 0.0, 0.0);
        // Place the creature in the band, but start A close enough that it enters view on the keyframe.
        let band_x = aoi::AOI_RADIUS + (aoi::AOI_HYSTERESIS / 2.0);
        let creature = vec![CreatureState(10, 0, band_x, 64.0, 0.0, 0.0, 2, 2)];
        room.players.get_mut(&1).unwrap().x = band_x - (aoi::AOI_RADIUS - 10.0);
        let players = states_of(&room);
        room.broadcast_snapshot(1, &players, &creature, &[]);
        let Outbound::Binary(k) = rx.try_recv().unwrap() else {
            panic!("keyframe");
        };
        assert_eq!(keyframe_ids(&k).1, vec![10], "creature is in view to start");

        // A backs off to the origin: the creature is now in the band (sticky), so it must remain — no removal.
        room.players.get_mut(&1).unwrap().x = 0.0;
        let players = states_of(&room);
        room.broadcast_snapshot(2, &players, &creature, &[]);
        let Outbound::Binary(d) = rx.try_recv().unwrap() else {
            panic!("delta");
        };
        assert!(
            delta_removed_creature_ids(&d).is_empty(),
            "a creature inside the hysteresis band stays in view (not removed)"
        );
    }

    #[tokio::test]
    async fn the_receivers_own_record_is_never_culled_even_at_the_map_edge() {
        // The receiving player's own record must always be present so their client can self-reconcile, even
        // when they stand alone at the far corner of the world with nothing else in range.
        let mut room = test_room().await;
        let edge = sim::WORLD_SIZE as f32;
        let mut rx = add_player_at(&mut room, 1, edge, edge);
        let players = states_of(&room);
        room.broadcast_snapshot(1, &players, &[], &[]);
        let Outbound::Binary(k) = rx.try_recv().unwrap() else {
            panic!("keyframe");
        };
        assert_eq!(
            keyframe_ids(&k).0,
            vec![1],
            "the receiver's own record is always present"
        );
    }

    #[tokio::test]
    async fn a_periodic_keyframe_still_fires_per_connection_under_aoi() {
        // The periodic keyframe (every KEYFRAME_INTERVAL_TICKS) still bounds each connection's baseline; it
        // now carries that connection's AOI view rather than the whole room.
        let mut room = test_room().await;
        let mut rx = add_player_at(&mut room, 1, 0.0, 0.0);
        let players = states_of(&room);
        room.broadcast_snapshot(1, &players, &[], &[]); // join keyframe
        let _ = rx.try_recv();
        room.broadcast_snapshot(2, &players, &[], &[]); // delta
        let _ = rx.try_recv();
        room.broadcast_snapshot(KEYFRAME_INTERVAL_TICKS, &players, &[], &[]);
        let Outbound::Binary(k) = rx.try_recv().unwrap() else {
            panic!("keyframe");
        };
        assert_eq!(k[1], protocol::snapshot_codec::FRAME_KEYFRAME);
        assert_eq!(
            keyframe_ids(&k).0,
            vec![1],
            "the periodic keyframe is the connection's own view"
        );
    }

    /// The changed-creature ids a DELTA frame carries. Walks the fixed layout: header, then the changed
    /// players block + their removed ids, then the changed creatures (id is each record's first u32).
    fn delta_changed_creature_ids(bytes: &[u8]) -> Vec<u32> {
        let (mut offset, _) = skip_delta_players(bytes);
        let read_u16 = |b: &[u8], o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as usize;
        let read_u32 =
            |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let count = read_u16(bytes, offset);
        offset += 2;
        (0..count)
            .map(|_| {
                let id = read_u32(bytes, offset);
                offset += 23;
                id
            })
            .collect()
    }

    /// The removed-creature ids a DELTA frame carries (skips past the changed-creature block to reach them).
    fn delta_removed_creature_ids(bytes: &[u8]) -> Vec<u32> {
        let (mut offset, _) = skip_delta_players(bytes);
        let read_u16 = |b: &[u8], o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as usize;
        let read_u32 =
            |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let changed = read_u16(bytes, offset);
        offset += 2 + changed * 23;
        let removed = read_u16(bytes, offset);
        offset += 2;
        (0..removed)
            .map(|_| {
                let id = read_u32(bytes, offset);
                offset += 4;
                id
            })
            .collect()
    }

    /// Advance past a DELTA frame's header and its whole players block (changed records + removed ids),
    /// returning the offset at the start of the creatures block. Player records are 33 bytes; ids are 4.
    fn skip_delta_players(bytes: &[u8]) -> (usize, ()) {
        assert_eq!(bytes[1], protocol::snapshot_codec::FRAME_DELTA, "delta");
        let read_u16 = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]) as usize;
        let mut offset = 18usize; // version(1) + kind(1) + tick(8) + baseline_tick(8)
        let changed = read_u16(offset);
        offset += 2 + changed * 33;
        let removed = read_u16(offset);
        offset += 2 + removed * 4;
        (offset, ())
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
            Arc::new(AtomicU32::new(0)),
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
            Arc::new(AtomicU32::new(0)),
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
    async fn holding_a_guest_broadcasts_pending_approvals_to_in_game_admins() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_approval_required(&room.key.0, true)
            .await
            .unwrap();
        // An admin is already in the room (the in-game admin who must get the live notification).
        let mut admin_rx = add_player(&mut room, 1, true);
        // A guest joins and is held for approval.
        let (held, _rx) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.60").await;
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
        room.on_join(
            String::new(),
            String::new(),
            look,
            banned_ip,
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
    /// fans out (those carry no roster). The roster is event-driven now, so a peer only sees one when a
    /// roster-affecting transition fired.
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
    async fn a_leave_broadcasts_an_updated_roster_with_one_fewer_player() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _leaver_rx = add_player(&mut room, 2, false);
        let conn2 = room.players.get(&2).unwrap().conn.clone();
        room.on_leave(2, &conn2, true);
        let roster = last_roster(&mut peer_rx).expect("a leave refreshes the roster");
        assert_eq!(roster.len(), 1, "the roster drops the player who left");
        assert!(roster.iter().all(|p| p.id != 2), "the leaver is gone");
    }

    #[tokio::test]
    async fn a_drop_then_resume_each_broadcast_an_away_toggled_roster() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _dropped_rx = add_player(&mut room, 2, false);
        let conn2 = room.players.get(&2).unwrap().conn.clone();
        // An abrupt drop marks the slot away=true and refreshes the roster (no Left during grace).
        room.on_leave(2, &conn2, false);
        let away = last_roster(&mut peer_rx).expect("a drop refreshes the roster");
        assert!(
            away.iter().find(|p| p.id == 2).unwrap().away,
            "the dropped player shows away in the roster",
        );
        // A reconnect resumes the held slot and refreshes the roster with away=false again.
        let (resumed, _r2) =
            admit_from_ip(&mut room, "acc2", "p2", Role::Player, "127.0.0.1").await;
        assert_eq!(resumed, Ok(2), "the slot resumes");
        let back = last_roster(&mut peer_rx).expect("a resume refreshes the roster");
        assert!(
            !back.iter().find(|p| p.id == 2).unwrap().away,
            "the resumed player is no longer away",
        );
    }

    #[tokio::test]
    async fn a_rename_broadcasts_an_updated_roster() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _renamed_rx = add_player(&mut room, 2, false);
        room.on_rename("acc2", "Renamed", "p2");
        let roster = last_roster(&mut peer_rx).expect("a rename refreshes the roster");
        assert_eq!(
            roster.iter().find(|p| p.id == 2).unwrap().name,
            "Renamed",
            "the new name rides the roster",
        );
    }

    #[tokio::test]
    async fn a_role_change_broadcasts_an_updated_roster() {
        let mut room = test_room().await;
        let mut admin_rx = add_player(&mut room, 1, true);
        add_player(&mut room, 2, false);
        room.on_admin_set_role(1, 2, protocol::Role::Moderator);
        let roster = last_roster(&mut admin_rx).expect("a role change refreshes the roster");
        assert!(
            roster.iter().find(|p| p.id == 2).unwrap().moderator,
            "the promoted player's badge rides the roster",
        );
    }

    #[tokio::test]
    async fn a_pvp_kill_broadcasts_an_updated_roster() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        add_player(&mut room, 2, false);
        room.pvp = true;
        // Stand the two players together and drain the attacker's hp to one hit from death.
        room.players.get_mut(&2).unwrap().hp = 1;
        for id in [1, 2] {
            let p = room.players.get_mut(&id).unwrap();
            p.x = 0.0;
            p.y = 0.0;
            p.z = 0.0;
        }
        let _ = last_roster(&mut peer_rx); // clear the join rosters
        room.on_attack_player(1, 2);
        assert_eq!(
            room.players.get(&1).unwrap().pvp_kills,
            1,
            "the kill landed",
        );
        let roster = last_roster(&mut peer_rx).expect("a pvp kill refreshes the roster");
        assert_eq!(
            roster.iter().find(|p| p.id == 1).unwrap().pvp_kills,
            1,
            "the bumped kill count rides the roster",
        );
    }

    #[tokio::test]
    async fn the_roster_is_not_rebroadcast_on_a_quiet_tick() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        add_player(&mut room, 2, false);
        // Both players hold a live claim so the reclaim-kick sweep leaves them in place: the stretch is
        // genuinely quiet (no leave/kick), exercising the path that used to re-send the roster.
        room.hub.claims.set("acc1", "tok1");
        room.hub.claims.set("acc2", "tok2");
        // No roster-affecting change happens — just advance many ticks past several STATUS_EVERY_TICKS
        // boundaries. The roster used to be re-sent every boundary; now a quiet tick emits none.
        let _ = last_roster(&mut peer_rx); // ignore anything queued before the quiet stretch
        for _ in 0..(STATUS_EVERY_TICKS * 4 + 3) {
            room.tick(0.05);
        }
        assert!(
            room.players.contains_key(&1) && room.players.contains_key(&2),
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
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _dropped_rx = add_player(&mut room, 2, false);
        let conn2 = room.players.get(&2).unwrap().conn.clone();
        room.on_leave(2, &conn2, false);
        room.players.get_mut(&2).unwrap().disconnected_at =
            Some(Instant::now() - RECONNECT_GRACE - Duration::from_secs(1));
        // Keep the observing peer alive through the sweep: register its claim so the reclaim-kick (which
        // fires for any account whose live claim isn't in the hub) leaves it in place to see the prune.
        room.hub.claims.set("acc1", "tok1");
        let _ = last_roster(&mut peer_rx); // clear the drop's roster
        room.tick = STATUS_EVERY_TICKS - 1;
        room.tick(0.05);
        let roster = last_roster(&mut peer_rx).expect("the prune refreshes the roster");
        assert_eq!(roster.len(), 1, "the pruned player leaves the roster");
        assert!(roster.iter().all(|p| p.id != 2), "the pruned slot is gone");
    }

    #[tokio::test]
    async fn a_dropped_socket_freezes_the_slot_without_an_immediate_left() {
        let mut room = test_room().await;
        // A peer stays connected so it can observe (or not) a Left for the dropped player.
        let mut peer_rx = add_player(&mut room, 1, false);
        let _dropped_rx = add_player(&mut room, 2, false);
        let conn2 = room.players.get(&2).unwrap().conn.clone();
        room.on_leave(2, &conn2, false);
        // The slot is held (avatar frozen), not removed, and no Left went out within the grace.
        assert!(
            room.players.contains_key(&2),
            "the slot is kept during grace"
        );
        assert!(
            room.players.get(&2).unwrap().disconnected_at.is_some(),
            "the slot is marked disconnected"
        );
        assert!(!saw_left(&mut peer_rx, 2), "no Left is broadcast on a blip");
    }

    #[tokio::test]
    async fn a_clean_close_removes_the_player_immediately_without_grace() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _leaver_rx = add_player(&mut room, 2, false);
        let conn2 = room.players.get(&2).unwrap().conn.clone();
        // A page reload / tab close sends a clean Close frame: the player is removed at once (no grace),
        // so their avatar vanishes for everyone immediately.
        room.on_leave(2, &conn2, true);
        assert!(
            !room.players.contains_key(&2),
            "a clean leave removes the slot at once"
        );
        assert!(
            saw_left(&mut peer_rx, 2),
            "a clean leave broadcasts Left immediately"
        );
    }

    #[tokio::test]
    async fn a_stale_leave_from_a_replaced_socket_is_ignored() {
        let mut room = test_room().await;
        let _rx = add_player(&mut room, 2, false);
        // Swap in a fresh connection (as a resume would), then deliver the OLD socket's late Leave.
        let (stale_conn, _stale_rx) = mpsc::channel::<Outbound>(64);
        let (live_conn, _live_rx) = mpsc::channel::<Outbound>(64);
        room.players.get_mut(&2).unwrap().conn = live_conn;
        room.on_leave(2, &stale_conn, false);
        assert!(
            room.players.get(&2).unwrap().disconnected_at.is_none(),
            "a Leave from a replaced socket never freezes the live slot"
        );
    }

    #[tokio::test]
    async fn a_rejoin_within_grace_resumes_the_same_slot_intact() {
        let mut room = test_room().await;
        // A guest joins from an IP, builds up score + inventory, then their socket drops.
        let (admitted, mut first_rx) =
            admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.7").await;
        let id = admitted.expect("guest admitted");
        {
            let p = room.players.get_mut(&id).unwrap();
            p.x = 12.0;
            p.y = 34.0;
            p.z = 56.0;
            p.score = 7;
            p.hp = 2;
            p.inventory.insert(3, 9);
        }
        let dropped_conn = room.players.get(&id).unwrap().conn.clone();
        room.on_leave(id, &dropped_conn, false);
        assert!(room.players.get(&id).unwrap().disconnected_at.is_some());

        // The same guest rejoins (same IP) within the grace.
        let (resumed, mut second_rx) =
            admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.7").await;
        assert_eq!(resumed, Ok(id), "the rejoin resumes the same player id");
        assert_eq!(room.players.len(), 1, "no duplicate slot is created");
        let p = room.players.get(&id).unwrap();
        assert!(p.disconnected_at.is_none(), "the slot is live again");
        assert_eq!((p.x, p.y, p.z), (12.0, 34.0, 56.0), "position is intact");
        assert_eq!(p.score, 7, "score is intact");
        assert_eq!(p.hp, 2, "hp is intact");
        assert_eq!(p.inventory.get(&3), Some(&9), "inventory is intact");
        // The resuming connection gets a Welcome for the SAME id; no Left was ever broadcast.
        assert_eq!(first_welcome_id(&mut second_rx), Some(id));
        assert!(
            !saw_left(&mut first_rx, id),
            "resume causes no Left/Join churn"
        );
    }

    #[tokio::test]
    async fn a_slot_still_gone_after_the_grace_is_pruned_with_one_left() {
        let mut room = test_room().await;
        let mut peer_rx = add_player(&mut room, 1, false);
        let _dropped_rx = add_player(&mut room, 2, false);
        let conn2 = room.players.get(&2).unwrap().conn.clone();
        room.on_leave(2, &conn2, false);
        // Backdate the disconnect beyond the grace so the next status sweep prunes it.
        room.players.get_mut(&2).unwrap().disconnected_at =
            Some(Instant::now() - RECONNECT_GRACE - Duration::from_secs(1));
        room.tick = STATUS_EVERY_TICKS - 1;
        room.tick(0.05);
        assert!(!room.players.contains_key(&2), "the expired slot is pruned");
        assert!(
            saw_left(&mut peer_rx, 2),
            "exactly the prune broadcasts Left"
        );
    }

    #[tokio::test]
    async fn an_authed_player_resumes_by_account_not_ip() {
        let mut room = test_room().await;
        // A logged-in player on one IP drops; they reconnect from a DIFFERENT IP (e.g. wifi → cellular).
        let (admitted, _first_rx) =
            admit_from_ip(&mut room, "acc-jo", "Jo", Role::Player, "198.51.100.1").await;
        let id = admitted.expect("authed player admitted");
        let dropped_conn = room.players.get(&id).unwrap().conn.clone();
        room.on_leave(id, &dropped_conn, false);
        let (resumed, _second_rx) =
            admit_from_ip(&mut room, "acc-jo", "Jo", Role::Player, "203.0.113.9").await;
        assert_eq!(
            resumed,
            Ok(id),
            "the account resumes its slot across an IP change"
        );
        assert_eq!(room.players.len(), 1, "no duplicate slot");
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
    async fn an_admin_over_the_playtime_budget_still_plays_but_a_moderator_does_not() {
        let mut room = test_room().await;
        room.hub
            .db
            .set_tenant_playtime(&room.key.0, 1, 24)
            .await
            .unwrap();
        // Burn the IP's budget: a guest plays 2 minutes, past the 1-minute limit.
        let (admitted, _rx) = admit_from_ip(&mut room, "", "", Role::Player, "203.0.113.9").await;
        let id = admitted.expect("first guest admitted");
        room.players.get_mut(&id).unwrap().joined_at_ms = epoch_ms() - 2 * 60_000;
        room.tick = STATUS_EVERY_TICKS - 1;
        room.tick(0.05);
        for _ in 0..50 {
            tokio::task::yield_now().await;
            let used = room
                .hub
                .db
                .playtime_used(
                    &room.key.0,
                    "ip:203.0.113.9",
                    24 * 3_600_000,
                    epoch_ms() as i64,
                )
                .await
                .unwrap();
            if used >= 60_000 {
                break;
            }
        }
        // A moderator from that over-budget IP is turned away — moderators are subject to the limit.
        let (mod_res, _r1) = admit_from_ip(&mut room, "", "", Role::Moderator, "203.0.113.9").await;
        assert_eq!(
            mod_res,
            Err("time_up".into()),
            "a moderator over budget is blocked"
        );
        // An admin from the same over-budget IP still gets in.
        let (admin_res, _r2) = admit_from_ip(&mut room, "", "", Role::Admin, "203.0.113.9").await;
        let admin_id = admin_res.expect("an admin over budget still plays");
        // And an admin already past their session time is never kicked by the play-time sweep.
        room.players.get_mut(&admin_id).unwrap().joined_at_ms = epoch_ms() - 5 * 60_000;
        room.tick = STATUS_EVERY_TICKS - 1;
        room.tick(0.05);
        assert!(
            room.players.contains_key(&admin_id),
            "an admin is never kicked by the playtime sweep"
        );
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
    async fn placing_a_block_swings_the_placers_avatar_for_everyone_else() {
        let mut room = test_room().await;
        let mut rx = add_player(&mut room, 1, false);
        let mut other_rx = add_player(&mut room, 2, false);
        room.world.set(10, 20, 11, sim::AIR);
        place_player_at(&mut room, 1, 10, 20, 10);

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
        let swung = std::iter::from_fn(|| other_rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Swing { id: 1 }));
        assert!(swung, "the other player sees the placer swing");
        let echoed = std::iter::from_fn(|| rx.try_recv_msg().ok())
            .any(|m| matches!(m, ServerMsg::Swing { .. }));
        assert!(!echoed, "the placer does not receive its own swing");
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

    /// A sequential reference for `broadcast_snapshot`: the same per-connection AOI-filter + keyframe/delta
    /// encode + baseline update the parallel path does, run one player at a time. The parallel broadcast
    /// must produce byte-identical frames and baselines to this regardless of the order it processed
    /// connections — that is the safety property of parallelizing only the read-only encode/send.
    fn sequential_broadcast(
        room: &mut Room,
        tick: u64,
        players: &[PlayerState],
        creatures: &[CreatureState],
        hearts: &[HeartDropState],
    ) {
        let periodic_keyframe = tick.is_multiple_of(KEYFRAME_INTERVAL_TICKS);
        let grids = AoiGrids::build(players, creatures, hearts);
        let ids: Vec<PlayerId> = room.players.keys().copied().collect();
        for id in ids {
            let receiver = room.players.get(&id).unwrap();
            let center = receiver_center(id, players);
            let view = aoi_view(
                id,
                center,
                &receiver.snapshot_baseline,
                &grids,
                players,
                creatures,
                hearts,
            );
            let send_keyframe = periodic_keyframe || receiver.needs_keyframe;
            let bytes: Arc<[u8]> = if send_keyframe {
                encode_keyframe(tick, &view.players, &view.creatures, &view.hearts).into()
            } else {
                let baseline = &receiver.snapshot_baseline;
                encode_delta(
                    SnapshotView {
                        tick: baseline.tick,
                        players: &baseline.players,
                        creatures: &baseline.creatures,
                        hearts: &baseline.hearts,
                    },
                    SnapshotView {
                        tick,
                        players: &view.players,
                        creatures: &view.creatures,
                        hearts: &view.hearts,
                    },
                )
                .into()
            };
            let receiver = room.players.get_mut(&id).unwrap();
            let _ = receiver.conn.try_send(Outbound::Binary(bytes));
            receiver.needs_keyframe = false;
            receiver.snapshot_baseline = SnapshotBaseline {
                tick,
                players: view.players,
                creatures: view.creatures,
                hearts: view.hearts,
            };
        }
    }

    /// Encode a stored baseline as a keyframe so two baselines compare by their wire bytes (the state
    /// structs don't derive PartialEq, and the bytes are exactly what the next delta is built against).
    fn encode_baseline(baseline: &SnapshotBaseline) -> Vec<u8> {
        encode_keyframe(
            baseline.tick,
            &baseline.players,
            &baseline.creatures,
            &baseline.hearts,
        )
    }

    /// Drain every Binary frame a connection received, in order.
    fn drain_binaries(rx: &mut mpsc::Receiver<Outbound>) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while let Ok(o) = rx.try_recv() {
            if let Outbound::Binary(bytes) = o {
                out.push(bytes.to_vec());
            }
        }
        out
    }

    #[tokio::test]
    async fn parallel_broadcast_is_byte_identical_to_a_sequential_reference() {
        // Build the SAME room state twice and broadcast a keyframe tick then a delta tick: once through the
        // real (parallel) `broadcast_snapshot`, once through the sequential reference. For every receiver the
        // sent bytes AND the resulting baseline must match exactly — parallelism only reorders the work.
        let layout = [(1u32, 0.0, 0.0), (2, 6.0, 0.0), (3, 50_000.0, 0.0)];
        let creatures = vec![
            CreatureState(10, 0, 4.0, 64.0, 0.0, 0.0, 2, 2),
            CreatureState(11, 0, 50_004.0, 64.0, 0.0, 0.0, 2, 2),
        ];
        let hearts = vec![HeartDropState(20, 3.0, 64.0, 0.0)];

        let mut par_room = test_room().await;
        let mut seq_room = test_room().await;
        let mut par_rx = HashMap::new();
        let mut seq_rx = HashMap::new();
        for (id, x, z) in layout {
            par_rx.insert(id, add_player_at(&mut par_room, id, x, z));
            seq_rx.insert(id, add_player_at(&mut seq_room, id, x, z));
        }
        let states = states_of(&par_room);

        // Tick 1: every connection is fresh -> keyframe of its own AOI view.
        par_room.broadcast_snapshot(1, &states, &creatures, &hearts);
        sequential_broadcast(&mut seq_room, 1, &states, &creatures, &hearts);
        // Tick 2: everyone in-sync -> a per-connection delta against its own baseline.
        par_room.broadcast_snapshot(2, &states, &creatures, &hearts);
        sequential_broadcast(&mut seq_room, 2, &states, &creatures, &hearts);

        for (id, _, _) in layout {
            assert_eq!(
                drain_binaries(par_rx.get_mut(&id).unwrap()),
                drain_binaries(seq_rx.get_mut(&id).unwrap()),
                "receiver {id} got byte-identical frames under the parallel path"
            );
            let par_baseline = &par_room.players.get(&id).unwrap().snapshot_baseline;
            let seq_baseline = &seq_room.players.get(&id).unwrap().snapshot_baseline;
            assert_eq!(par_baseline.tick, seq_baseline.tick, "baseline tick {id}");
            assert_eq!(
                encode_baseline(par_baseline),
                encode_baseline(seq_baseline),
                "baseline contents {id}"
            );
        }
    }

    #[tokio::test]
    async fn the_parallel_broadcast_serves_correct_views_to_two_hundred_players() {
        // At high single-room counts the parallel path must still produce each receiver's correct AOI view.
        // Place 200 players in tight pairs spread far apart: each player sees only itself and its pair-mate.
        let mut room = test_room().await;
        let mut receivers = HashMap::new();
        let pairs = 100u32;
        for pair in 0..pairs {
            let base = pair * 2 + 1;
            let x = pair as f32 * 10_000.0;
            receivers.insert(base, add_player_at(&mut room, base, x, 0.0));
            receivers.insert(base + 1, add_player_at(&mut room, base + 1, x + 3.0, 0.0));
        }
        let states = states_of(&room);
        room.broadcast_snapshot(1, &states, &[], &[]);

        for pair in 0..pairs {
            let base = pair * 2 + 1;
            for id in [base, base + 1] {
                let Outbound::Binary(frame) = receivers.get_mut(&id).unwrap().try_recv().unwrap()
                else {
                    panic!("player {id} must get a Binary keyframe");
                };
                let mut seen = keyframe_ids(&frame).0;
                seen.sort_unstable();
                assert_eq!(
                    seen,
                    vec![base, base + 1],
                    "player {id} sees only its own pair, not the distant others"
                );
            }
        }
    }
}
