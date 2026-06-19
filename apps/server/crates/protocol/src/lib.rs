//! Wire protocol shared between the authoritative server and the (future WASM) client.
//! JSON over WebSocket for now; swap to a binary codec later without touching call sites.

use serde::{Deserialize, Serialize};

pub type PlayerId = u32;

/// Messages the client sends to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditOp {
    Place,
    Break,
}

/// Messages the server sends to the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        you: PlayerId,
        tenant: String,
        world: String,
        brand: Brand,
        tick_hz: u32,
        spawn: [f32; 3],
    },
    Snapshot {
        tick: u64,
        players: Vec<PlayerState>,
    },
    Edit {
        x: i32,
        y: i32,
        z: i32,
        id: u8,
        by: PlayerId,
    },
    Ping {
        nonce: u32,
    },
    Chat {
        from: PlayerId,
        name: String,
        text: String,
    },
    Left {
        id: PlayerId,
    },
    Error {
        code: String,
        msg: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerState {
    pub id: PlayerId,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub ping_ms: u32,
}

/// White-label branding handed to the client on join.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Brand {
    pub name: String,
    pub primary: String,
    pub logo: Option<String>,
}
