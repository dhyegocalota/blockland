//! Wire protocol shared between the authoritative server and the web client.
//! JSON over WebSocket for now; swap to a binary codec later without touching call sites.
//!
//! The TypeScript counterpart is generated from these types by the `export_typescript_bindings`
//! test (ts-rs) into `shared/ts/protocol.ts`, so the client never hand-writes the wire shapes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type PlayerId = u32;

/// Messages the client sends to the server.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        tenant: String,
        world: String,
        name: String,
        skin: String,
        shirt: String,
        hair: String,
        claim: String,
    },
    Move {
        x: f32,
        y: f32,
        z: f32,
        yaw: f32,
        pitch: f32,
    },
    Edit {
        op: EditOp,
        x: i32,
        y: i32,
        z: i32,
        id: u8,
    },
    Pong {
        nonce: u32,
    },
    Chat {
        text: String,
    },
    /// Attack the creature with this id; the server validates range and applies the damage.
    Hit {
        id: u32,
    },
    EditBatch {
        edits: Vec<EditCell>,
    },
    /// Admin-only: toggle the room-wide peace mode (calms monsters for everyone). Ignored from non-admins.
    AdminSetPeace {
        on: bool,
    },
    /// Admin-only: allow or block a prebuilt structure kind for the room. Ignored from non-admins.
    AdminSetStructure {
        kind: String,
        allowed: bool,
    },
    /// Admin-only: toggle room-wide player-vs-player combat. Ignored from non-admins.
    AdminSetPvp {
        on: bool,
    },
    /// Admin-only: enable or disable the room chat. Ignored from non-admins.
    AdminSetChat {
        on: bool,
    },
    /// Admin-only: toggle this player's infinite-resources mode (build without spending). Ignored
    /// from non-admins.
    AdminSetInfinite {
        on: bool,
    },
    /// Admin-only: disconnect a player by id (they may rejoin). Ignored from non-admins.
    AdminKick {
        id: u32,
    },
    /// Admin-only: permanently ban a player by id (disconnect + block their address). Ignored from non-admins.
    AdminBan {
        id: u32,
    },
    /// Attack another player by id; the server validates pvp + range and tells the target it was hit.
    AttackPlayer {
        id: u32,
    },
    /// Moderator+admin: wipe the world (all edits + creatures) for everyone. Ignored from players.
    AdminResetWorld,
    /// Admin-only: wipe every player's score + the leaderboard for this world. Ignored from non-admins.
    AdminResetScores,
    /// Admin-only: suspend (or resume) the world. While suspended everyone is disconnected to the lobby
    /// and no one can join, until an admin resumes it. Ignored from non-admins.
    AdminSuspend {
        on: bool,
    },
    /// Admin-only (or moderator setting a moderator): change an online player's role by id. Ignored
    /// when the sender lacks the authority to grant the requested role.
    AdminSetRole {
        id: u32,
        role: Role,
    },
    /// Admin-only: require approval for new players (or turn it off). While on, a logged-in player who
    /// is not yet approved is held out until an admin approves them. Ignored from non-admins.
    AdminSetApproval {
        on: bool,
    },
    /// Admin-only: approve a pending account so it may join. Clears its pending request. Ignored from
    /// non-admins.
    AdminApprove {
        account_id: String,
    },
    /// Admin-only: reject a pending account. It stays out (its next join attempt is told "rejected")
    /// until an admin later approves it. Ignored from non-admins.
    AdminReject {
        account_id: String,
    },
    /// Admin-only: permanently ban a player still waiting for approval, keyed by their approval key
    /// (`ip:<addr>` for a guest, else the account's IP). Their address is blocked and the pending
    /// request dropped. Ignored from non-admins.
    AdminBanPending {
        account_id: String,
    },
    /// Admin-only: lift a global IP ban so that address can join again. Ignored from non-admins.
    AdminUnban {
        ip: String,
    },
    /// Admin-only: set the per-tenant play-time budget (minutes allowed within a rolling window of
    /// hours). 0 minutes means unlimited. Persisted to the tenant row + applied live. Ignored from
    /// non-admins.
    AdminSetLimits {
        playtime_limit_min: u32,
        playtime_window_h: u32,
    },
    /// Admin-only: choose which game modes the tenant allows. Disabling the last enabled mode is
    /// rejected (a tenant always keeps at least one). Persisted + broadcast. Ignored from non-admins.
    AdminSetModes {
        online_allowed: bool,
        offline_allowed: bool,
    },
    /// Ask the server to send the player back to spawn (the "back to start" button, and on death). The
    /// server moves them authoritatively and re-baselines the anti-cheat so the teleport is not rejected.
    Respawn,
    /// One tap against a block while digging. The server counts taps per block and decides when it breaks
    /// (after DIG_HITS), so the dig difficulty is authoritative — a modified client can't break instantly.
    Dig {
        x: i32,
        y: i32,
        z: i32,
    },
}

/// A player's capability tier on the wire. Mirrors the server `db::Role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Player,
    Moderator,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum EditOp {
    Place,
    Break,
}

/// One absolute voxel write; `id` of 0 (air) means break. Used for bulk edits (structures) and to
/// hand the current world to a player who just joined.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct EditCell {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub id: u8,
}

/// Messages the server sends to the client.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        you: u32,
        tenant: String,
        world: String,
        brand: Brand,
        tick_hz: u32,
        spawn: [f32; 3],
        admin: bool,
        moderator: bool,
        /// Server build identifier (GIT_SHA when deployed, else the crate version), shown in the debug panel.
        version: String,
    },
    /// The hot per-tick message, encoded as compactly as possible: single-letter keys and each player,
    /// creature and heart drop is a fixed-order number array (see `PlayerState`/`CreatureState`/
    /// `HeartDropState`) instead of named fields. `k` = tick, `p` = players, `c` = creatures, `h` = heart
    /// drops. The client decodes it at the net boundary.
    Snapshot {
        #[serde(rename = "k")]
        #[ts(type = "number")]
        tick: u64,
        #[serde(rename = "p")]
        players: Vec<PlayerState>,
        #[serde(rename = "c")]
        creatures: Vec<CreatureState>,
        #[serde(rename = "h")]
        hearts: Vec<HeartDropState>,
    },
    Edit {
        x: i32,
        y: i32,
        z: i32,
        id: u8,
        by: u32,
    },
    EditBatch {
        edits: Vec<EditCell>,
        by: u32,
    },
    Ping {
        nonce: u32,
    },
    Chat {
        from: u32,
        name: String,
        text: String,
    },
    Left {
        id: u32,
    },
    Error {
        code: String,
        msg: String,
    },
    /// A persisted timeline event (e.g. a rename), broadcast live and replayed as backlog on join.
    Event {
        kind: String,
        name: String,
        detail: String,
    },
    /// Room-wide settings an admin controls; broadcast on change and sent once on join.
    RoomState {
        peace: bool,
        blocked_structures: Vec<String>,
        pvp: bool,
        chat_enabled: bool,
        suspended: bool,
        approval_required: bool,
        /// Per-tenant play-time budget: minutes allowed within a rolling window of hours (0 minutes =
        /// unlimited). Surfaced so the admin panels show + edit the live values without a rejoin.
        playtime_limit_min: u32,
        playtime_window_h: u32,
        /// Which game modes the tenant allows. The lobby also learns these before joining (via the
        /// tenant HTTP fetch); online-blocking is enforced server-side, offline-blocking client-side.
        online_allowed: bool,
        offline_allowed: bool,
    },
    /// The accounts waiting for an admin to approve them; sent to admins on join and whenever the
    /// pending list changes (a held-out join arrives, or an admin approves someone).
    PendingApprovals {
        pending: Vec<PendingApproval>,
    },
    /// The banned IPs (with the name they were banned under); sent to admins on join and whenever the
    /// ban list changes, so they can unban from the in-game panel.
    Bans {
        bans: Vec<BanEntry>,
    },
    /// Sent to a player who was just hit by another player in PvP; the client takes the damage.
    Hurt {
        by: String,
    },
    /// Sent to a player whose role just changed in-game, so their controls update without a rejoin.
    Role {
        admin: bool,
        moderator: bool,
    },
    /// A hit landed on a target so every client plays the same attack effect (flash + puff). `kind`
    /// is "creature" or "player"; `id` is that target's id. Broadcast to everyone but the attacker.
    Attack {
        kind: String,
        id: u32,
    },
    /// A player performed a primary action (dig tap / creature hit / pvp attack), so every other client
    /// swings that player's avatar arm. `id` is the acting player's id. Purely cosmetic (no damage);
    /// broadcast to everyone but the actor (who already swung their own first-person view locally).
    Swing {
        id: u32,
    },
    /// The server moved this player to spawn (on request or death) with full health; the client snaps
    /// its position onto it (re-baselining the anti-cheat) and refills its hearts.
    Respawn {
        x: f32,
        y: f32,
        z: f32,
        hp: u8,
    },
    /// This player's authoritative block inventory: counts per block id, with `infinite` set while the
    /// player builds without spending (admins). Sent on join and whenever a count or the flag changes.
    Inventory {
        items: Vec<InventoryItem>,
        infinite: bool,
    },
    /// The static identity (name + look) of every online player. Sent on join and on the periodic sweep
    /// so the per-tick Snapshot can stay slim (dynamics only) instead of re-sending names + colors 30×/s.
    Roster {
        players: Vec<PlayerMeta>,
    },
}

/// One block-id count in a player's inventory.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
pub struct InventoryItem {
    pub id: u8,
    pub count: u32,
}

/// A player's identity + current room role, carried by `Roster` so `PlayerState` (per tick) can omit
/// it. The role lets the lobby/admin UI badge admins and reflect promotions in real time.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlayerMeta {
    pub id: u32,
    pub name: String,
    pub skin: String,
    pub shirt: String,
    pub hair: String,
    pub admin: bool,
    pub moderator: bool,
    pub pvp_kills: u32,
}

/// One player's per-tick dynamics as a fixed-order number array (no field names, to keep the hot
/// Snapshot tiny): `[id, x, y, z, yaw, pitch, ping_ms, score, hp]`. Identity (name/skin/shirt/hair)
/// is sent separately via `Roster`. The client decodes the index order back into named fields.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlayerState(
    pub u32,
    pub f32,
    pub f32,
    pub f32,
    pub f32,
    pub f32,
    pub u32,
    pub u32,
    pub u8,
);

/// A server-simulated creature every client renders identically, as a fixed-order number array:
/// `[id, kind_index, x, y, z, yaw, hp, max_hp]`. `kind_index` is the position in the shared kind
/// table (pig=0, chicken=1, cow=2, slime=3, spider=4); the client maps it back to a model. `hp` of 0
/// never appears (it is removed on death).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreatureState(
    pub u32,
    pub u8,
    pub f32,
    pub f32,
    pub f32,
    pub f32,
    pub u8,
    pub u8,
);

/// One heart pickup dropped by a defeated creature, as a fixed-order number array (no field names, to
/// keep the hot Snapshot tiny): `[id, x, y, z]`. A player who walks over it while below MAX_HP collects
/// it for +1 heart; the server removes it on pickup or once its TTL expires, so it stops appearing here.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HeartDropState(pub u32, pub f32, pub f32, pub f32);

/// One account awaiting an admin's approval before it can join (name + email for the admin to recognize).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PendingApproval {
    pub account_id: String,
    pub name: String,
    pub email: String,
}

/// A banned IP and the name it was banned under, for the in-game admin unban list.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct BanEntry {
    pub ip: String,
    pub name: String,
}

/// White-label branding handed to the client on join: a display name and one image URL that
/// serves both the lobby avatar and the in-game face-block texture.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Brand {
    pub name: String,
    pub image: String,
}

#[cfg(test)]
mod snapshot_size {
    use super::*;

    /// The number of decimals snapshot coordinates are rounded to before going on the wire (the server
    /// does the rounding); the named baseline below uses the same rounded values for a fair comparison.
    const DECIMALS: usize = 2;
    /// The shared creature kind table (mirrors the server `CreatureKind::ALL`), used only to rebuild
    /// the old slug-carrying named baseline for the size comparison.
    const KIND_SLUGS: [&str; 5] = ["pig", "chicken", "cow", "slime", "spider"];

    fn sample_snapshot() -> ServerMsg {
        let players = (0..10)
            .map(|i| {
                PlayerState(
                    i,
                    round(i as f32 * 1.37 + 12.5),
                    round(64.25),
                    round(i as f32 * -2.11 - 8.0),
                    round(i as f32 * 0.31),
                    round(0.05),
                    20 + i,
                    i * 3,
                    3,
                )
            })
            .collect();
        let creatures = (0..20)
            .map(|i| {
                CreatureState(
                    100 + i,
                    (i % 5) as u8,
                    round(i as f32 * 0.9 - 30.0),
                    round(63.5),
                    round(i as f32 * 1.4 + 5.0),
                    round(i as f32 * 0.2),
                    2,
                    3,
                )
            })
            .collect();
        let hearts = (0..3)
            .map(|i| {
                HeartDropState(
                    200 + i,
                    round(i as f32 * 2.0 - 5.0),
                    round(63.5),
                    round(i as f32 * 1.1),
                )
            })
            .collect();
        ServerMsg::Snapshot {
            tick: 1_234,
            players,
            creatures,
            hearts,
        }
    }

    fn round(value: f32) -> f32 {
        let scale = 10f32.powi(DECIMALS as i32);
        (value * scale).round() / scale
    }

    /// Rebuild the same snapshot in the OLD named-field JSON shape, to measure what the compact numeric
    /// encoding saves. Mirrors the pre-change wire (objects with `id`/`x`/.../`hp` and `kind` slugs).
    fn named_baseline_bytes(msg: &ServerMsg) -> usize {
        let ServerMsg::Snapshot {
            tick,
            players,
            creatures,
            hearts,
        } = msg
        else {
            unreachable!()
        };
        let players: Vec<_> = players
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.0, "x": p.1, "y": p.2, "z": p.3, "yaw": p.4,
                    "pitch": p.5, "ping_ms": p.6, "score": p.7, "hp": p.8,
                })
            })
            .collect();
        let creatures: Vec<_> = creatures
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.0, "kind": KIND_SLUGS[c.1 as usize], "x": c.2, "y": c.3,
                    "z": c.4, "yaw": c.5, "hp": c.6, "max_hp": c.7,
                })
            })
            .collect();
        let hearts: Vec<_> = hearts
            .iter()
            .map(|h| serde_json::json!({ "id": h.0, "x": h.1, "y": h.2, "z": h.3 }))
            .collect();
        let named = serde_json::json!({
            "t": "snapshot", "tick": tick, "players": players, "creatures": creatures, "hearts": hearts,
        });
        serde_json::to_string(&named).unwrap().len()
    }

    /// The compact numeric snapshot for 10 players + 20 creatures must stay tiny and be materially
    /// smaller than the old named-field JSON. Measured (this build): compact 1075 B vs named 3816 B
    /// (~28%). The bounds below leave headroom while guarding against an accidental shape regression.
    #[test]
    fn numeric_snapshot_is_far_smaller_than_named_json() {
        let msg = sample_snapshot();
        let compact = serde_json::to_string(&msg).unwrap();
        let compact_bytes = compact.len();
        let named_bytes = named_baseline_bytes(&msg);

        assert!(
            compact_bytes < 1_200,
            "compact snapshot grew past its bound: {compact_bytes} bytes\n{compact}"
        );
        assert!(
            compact_bytes * 100 < named_bytes * 55,
            "compact {compact_bytes} B is not < 55% of named {named_bytes} B"
        );
    }
}

#[cfg(test)]
mod export {
    use super::*;

    /// Generate the TypeScript bindings consumed by the web client. Run via `cargo test`.
    #[test]
    fn export_typescript_bindings() {
        let mut out = String::new();
        out.push_str(
            "// AUTO-GENERATED from apps/server/crates/protocol via ts-rs. Do not edit.\n",
        );
        out.push_str("// Regenerate with: cargo test -p protocol\n\n");
        for decl in [
            Brand::decl(),
            EditOp::decl(),
            Role::decl(),
            EditCell::decl(),
            InventoryItem::decl(),
            PlayerMeta::decl(),
            PlayerState::decl(),
            CreatureState::decl(),
            HeartDropState::decl(),
            PendingApproval::decl(),
            BanEntry::decl(),
            ClientMsg::decl(),
            ServerMsg::decl(),
        ] {
            out.push_str("export ");
            out.push_str(&decl);
            out.push_str("\n\n");
        }

        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../web/lib/protocol.gen.ts"
        );
        let parent = std::path::Path::new(path).parent().unwrap();
        std::fs::create_dir_all(parent).unwrap();
        std::fs::write(path, out).unwrap();
    }
}
