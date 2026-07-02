//! The `#[wasm_bindgen]` surface the browser's offline loop drives: build a room, add the single local
//! player (who is the admin, like the web `grantOfflineAdmin`), feed inputs, tick, and drain the queued
//! outbound messages. Small + documented on purpose — this is the exact seam the TS offline path calls
//! in Stage 3. Everything below is wasm-only; the pure backings live in `memory`.

use std::sync::atomic::AtomicU32;
use std::sync::Arc;

use game_core::time::{set_now_ms, set_wall_ms, Instant};
use game_core::{playtime_key, Admission, Appearance, Conn, Role, Room, RoomConfig};
use js_sys::Uint8Array;
use protocol::client_codec::{decode_client_msg, encode_client_msg as codec_encode_client_msg};
use protocol::{ClientMsg, PlayerId};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::log_bridge;
use crate::memory::{DrainedMessage, NoPersistence, WasmHost, WasmSink};

/// The fixed room limits the offline core builds its `RoomConfig` from, deserialized from the JSON the JS
/// side passes to `WasmCore::new` (so the values mirror `tenants.toml` without being hardcoded here). All
/// fields are required — a missing one is a caller bug surfaced as a deserialize error, not silently defaulted.
#[derive(Deserialize)]
struct WasmConfig {
    tenant: String,
    world: String,
    brand_name: String,
    brand_image: String,
    tick_hz: u32,
    max_players: usize,
    idle_secs: u64,
    edit_reach: f32,
    max_speed: f32,
    move_per_sec: f32,
    edit_per_sec: f32,
    chat_per_sec: f32,
}

/// The local player's cosmetic look, deserialized from the JSON `WasmCore::add_local_player` receives.
#[derive(Deserialize)]
struct WasmLook {
    skin: String,
    shirt: String,
    hair: String,
}

/// One drained outbound message handed to JS: a JSON `ServerMsg` (text frame) or the binary snapshot
/// blob. `kind` lets the offline loop split them exactly like the WebSocket client splits text vs binary.
#[wasm_bindgen]
pub struct OutboundMessage {
    kind: OutboundKind,
    json: String,
    binary: Vec<u8>,
}

#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum OutboundKind {
    Json,
    Binary,
}

#[wasm_bindgen]
impl OutboundMessage {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> OutboundKind {
        self.kind
    }
    /// The JSON `ServerMsg` text, valid only when `kind == Json`.
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
    /// The binary snapshot blob, valid only when `kind == Binary`.
    #[wasm_bindgen(getter)]
    pub fn binary(&self) -> Uint8Array {
        Uint8Array::from(self.binary.as_slice())
    }
}

impl From<DrainedMessage> for OutboundMessage {
    fn from(msg: DrainedMessage) -> Self {
        match msg {
            DrainedMessage::Json(json) => Self {
                kind: OutboundKind::Json,
                json,
                binary: Vec::new(),
            },
            DrainedMessage::Binary(binary) => Self {
                kind: OutboundKind::Binary,
                json: String::new(),
                binary,
            },
        }
    }
}

/// The browser-facing offline core: a `game-core::Room` wired to the in-memory sink/host/persistence,
/// plus the shared sink handle the loop drains. Single-player — `add_local_player` is meant to be called
/// once; the lone player is admitted as the room admin (offline parity with the web `grantOfflineAdmin`).
#[wasm_bindgen]
pub struct WasmCore {
    room: Room,
    sink: WasmSink,
    local_account_id: String,
    local_ip: std::net::IpAddr,
}

#[wasm_bindgen]
impl WasmCore {
    /// Build an offline room from a JS-provided `seed` (reseeds the simulation RNG so spawns are
    /// deterministic) and a JSON `config` (the fixed limits, mirroring `tenants.toml`). `debug` installs
    /// the tracing→console bridge so `[BL:*]` logs show in DevTools. `now_ms` seeds the monotonic clock
    /// (`performance.now()`); the playtime stamp comes from `wall_ms` (`Date.now()`).
    #[wasm_bindgen(constructor)]
    pub fn new(
        seed: f64,
        config: &str,
        now_ms: f64,
        wall_ms: f64,
        debug: bool,
    ) -> Result<WasmCore, JsValue> {
        log_bridge::install(debug);
        set_now_ms(now_ms);
        set_wall_ms(wall_ms);

        let cfg: WasmConfig = serde_json::from_str(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;
        let local_account_id = format!("offline:{}", cfg.tenant);
        let local_claim = local_account_id.clone();

        let room_config = RoomConfig {
            tenant: cfg.tenant,
            world: cfg.world,
            brand_name: cfg.brand_name,
            brand_image: cfg.brand_image,
            tick_hz: cfg.tick_hz,
            max_players: cfg.max_players,
            idle_secs: cfg.idle_secs,
            edit_reach: cfg.edit_reach,
            max_speed: cfg.max_speed,
            move_per_sec: cfg.move_per_sec,
            edit_per_sec: cfg.edit_per_sec,
            chat_per_sec: cfg.chat_per_sec,
        };

        let sink = WasmSink::new();
        let host = Arc::new(WasmHost::new(local_account_id.clone(), local_claim));
        let mut room = Room::new(room_config, Arc::new(NoPersistence), host);
        // Offline seeds deterministically (native stays from-entropy): same seed + inputs ⇒ same spawns.
        room.reseed(seed as u64);

        tracing::info!(tenant = %room.key().0, "offline wasm core created");
        Ok(WasmCore {
            room,
            sink,
            local_account_id,
            local_ip: std::net::Ipv4Addr::LOCALHOST.into(),
        })
    }

    /// Add the single local player and return its id. The player is admitted as the room ADMIN (offline
    /// parity with the web `grantOfflineAdmin`): offline has one client, the player, who controls the world.
    /// `name` may be empty (the room names a guest). `look` is a JSON `{skin,shirt,hair}`.
    #[wasm_bindgen]
    pub fn add_local_player(&mut self, name: &str, look: &str) -> Result<PlayerId, JsValue> {
        let look: WasmLook = serde_json::from_str(look)
            .map_err(|e| JsValue::from_str(&format!("invalid look: {e}")))?;
        let conn: Conn = Arc::new(self.sink.handle());
        let admission = Admission {
            account_id: self.local_account_id.clone(),
            name: name.to_string(),
            role: Role::Admin,
            claim: self.local_account_id.clone(),
            look: Appearance {
                skin: look.skin,
                shirt: look.shirt,
                hair: look.hair,
            },
            ip: self.local_ip,
            // Offline single-player is the local player, never a headless monitor.
            observer: false,
            ping: Arc::new(AtomicU32::new(0)),
            playtime_key: playtime_key(&self.local_account_id, self.local_ip),
            playtime_baseline_ms: 0,
            backlog: Vec::new(),
            // An admin join carries the pending-approval list; offline has none, so an empty list.
            admin_pending: Some(Some(Vec::new())),
        };
        let id = self.room.add_player(Instant::now(), admission, conn);
        Ok(id)
    }

    /// Feed one client input (a BINARY `ClientMsg`, the exact wire frame the web client now sends over the
    /// socket — see `protocol::client_codec`) for the given player. `now_ms` advances the monotonic clock
    /// first, so the room timestamps it correctly. One format (binary) drives online + offline alike.
    #[wasm_bindgen]
    pub fn input(&mut self, player_id: PlayerId, msg: &[u8], now_ms: f64) -> Result<(), JsValue> {
        set_now_ms(now_ms);
        let msg: ClientMsg = decode_client_msg(msg)
            .map_err(|e| JsValue::from_str(&format!("invalid client message: {e}")))?;
        self.room.on_input(Instant::now(), player_id, msg);
        Ok(())
    }

    /// Advance the simulation one tick. `now_ms`/`wall_ms` feed the monotonic + wall clocks; `dt` is the
    /// seconds since the last tick. Returns whether the room is still open (offline keeps it open).
    #[wasm_bindgen]
    pub fn tick(&mut self, now_ms: f64, wall_ms: f64, dt: f32) -> bool {
        set_now_ms(now_ms);
        set_wall_ms(wall_ms);
        self.room.tick_at(Instant::now(), dt)
    }

    /// Drain every queued outbound message (the room's Welcome/roster/edits/snapshots) for the JS loop to
    /// apply, in the order the room produced them. Empties the queue.
    #[wasm_bindgen]
    pub fn drain_outbound(&mut self) -> Vec<OutboundMessage> {
        self.sink
            .drain()
            .into_iter()
            .map(OutboundMessage::from)
            .collect()
    }

    /// The current world edits for chunk `(cx, cz)` as a flat `[x,y,z,id, …]` `i32` array (id in the low
    /// byte), the same per-chunk built-structure data the server streams — the renderer overlays these on
    /// the procedural base it already generates locally.
    #[wasm_bindgen]
    pub fn chunk_edits(&self, cx: i32, cz: i32) -> Vec<i32> {
        self.room
            .world_edits_in_chunk(cx, cz)
            .into_iter()
            .flat_map(|(x, y, z, id)| [x, y, z, id as i32])
            .collect()
    }

    /// The encoded world diff (every edit, `sim::encode_edits` format) — a compact blob the JS side can
    /// persist or hand back. Offline keeps no db, so this is the only way to snapshot the built world.
    #[wasm_bindgen]
    pub fn world_blob(&self) -> Uint8Array {
        Uint8Array::from(self.room.world_snapshot_blob().as_slice())
    }
}

/// Encode one client message to its compact BINARY wire frame (`protocol::client_codec`), the single Rust
/// encoder the web client sends through. `msg` is the JSON `ClientMsg` the TS factories build (so the client
/// keeps no hand-written encoder); this parses it and returns the bytes the socket sends as a binary frame
/// (and the offline core feeds straight into `WasmCore::input`). STANDALONE — no Room/WasmCore needed.
#[wasm_bindgen]
pub fn encode_client_msg(json: &str) -> Result<Uint8Array, JsValue> {
    let msg: ClientMsg = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("invalid client message: {e}")))?;
    Ok(Uint8Array::from(codec_encode_client_msg(&msg).as_slice()))
}

/// The full procedural base of one chunk `(cx, cz)` as a flat `CHUNK*CHUNK*SIZE_Y` byte array (the TS
/// `lx + lz*CHUNK + y*CHUNK*CHUNK` layout), straight from `sim::worldgen_chunk`. STANDALONE — no Room or
/// `WasmCore` instance needed — so the client store fills a chunk's base from the single Rust source
/// (deleting its TS worldgen duplicate) with one call per chunk; all hot per-voxel reads stay in the TS
/// cache. Online AND offline call this, so the terrain base always matches the server's authoritative world.
#[wasm_bindgen]
pub fn worldgen_chunk(cx: i32, cz: i32) -> Uint8Array {
    Uint8Array::from(sim::worldgen_chunk(cx, cz).as_slice())
}
