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
    /// Admin-only (or moderator setting a moderator): change an online player's role by id. Ignored
    /// when the sender lacks the authority to grant the requested role.
    AdminSetRole {
        id: u32,
        role: Role,
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
    },
    Snapshot {
        #[ts(type = "number")]
        tick: u64,
        players: Vec<PlayerState>,
        creatures: Vec<CreatureState>,
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
    /// The server moved this player to spawn (on request or death) with full health; the client snaps
    /// its position onto it (re-baselining the anti-cheat) and refills its hearts.
    Respawn {
        x: f32,
        y: f32,
        z: f32,
        hp: u8,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlayerState {
    pub id: u32,
    pub name: String,
    pub skin: String,
    pub shirt: String,
    pub hair: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub ping_ms: u32,
    pub score: u32,
    pub hp: u8,
}

/// A server-simulated creature every client renders identically. `hp` of 0 never appears (it is
/// removed on death); `kind` is a slug like "pig"/"slime" the client maps to a model.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreatureState {
    pub id: u32,
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub hp: u8,
    pub max_hp: u8,
}

/// White-label branding handed to the client on join.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Brand {
    pub name: String,
    pub primary: String,
    pub logo: Option<String>,
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
            PlayerState::decl(),
            CreatureState::decl(),
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
