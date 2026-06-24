//! Plain telemetry data the room publishes for the admin endpoint, plus the timeline backlog event the
//! admit policy replays to a joining player. Pure data, so the game logic can own them without pulling
//! in the hub or db.

use serde::Serialize;

pub type RoomKey = (String, String);

/// One row per online player in the admin view.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerInfo {
    pub id: u32,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub ping_ms: u32,
    pub idle_ms: u64,
    pub joined_at_ms: u64,
}

/// Per-room snapshot published every tick for the admin endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct RoomSnapshot {
    pub tenant: String,
    pub world: String,
    pub tick: u64,
    pub edits: usize,
    pub players: Vec<PlayerInfo>,
}

/// One recent timeline event the admit policy replays to a joining connection: the pure shape the room
/// reads (`kind`/`name`/`detail`), mapped from the db's `TimelineEvent` by the server before it hands a
/// cleared-to-join `Admission` to the sync `add_player`.
pub struct BacklogEvent {
    pub kind: String,
    pub name: String,
    pub detail: String,
}
