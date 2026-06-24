//! Pure, sync authoritative game logic for a Blockland room, extracted out of the I/O server shell.
//! Depends only on `sim`, `protocol`, `rand`, `tracing` (+ `rayon` off wasm). The room owns the world,
//! validates every input, and broadcasts snapshots; the server backs the async db/policy/tick driver
//! and the hub-backed seams (`RoomHost`, `Persistence`, `OutboundSink`) around it.

pub mod aoi;
pub mod chat;
pub mod conn;
pub mod creatures;
pub mod host;
pub mod persistence;
pub mod role;
pub mod room;
pub mod spatial_grid;
pub mod stats;
pub mod time;
mod web_constants;

pub use conn::{next_conn_id, Appearance, Conn, Outbound, OutboundSink, NEXT_CONN_ID};
pub use host::{RoomConfig, RoomHost, TenantFlag};
pub use persistence::Persistence;
pub use role::Role;
pub use room::{playtime_key, Admission, Room};
pub use stats::{BacklogEvent, PlayerInfo, RoomKey, RoomSnapshot};
