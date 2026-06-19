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
    EditBatch {
        edits: Vec<EditCell>,
    },
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
    },
    Snapshot {
        #[ts(type = "number")]
        tick: u64,
        players: Vec<PlayerState>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PlayerState {
    pub id: u32,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub ping_ms: u32,
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
            EditCell::decl(),
            PlayerState::decl(),
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
