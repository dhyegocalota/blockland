//! The in-memory (db-free) backings of `game-core`'s three host seams, for a single-player offline
//! server: a queue-backed `OutboundSink`, a no-op `Persistence`, and a trivial in-memory `RoomHost`.
//! Nothing here touches a database, a socket, or wasm-bindgen — it is plain Rust the native unit tests
//! drive directly (proving the queue/host/persistence behave) and the wasm `WasmCore` wraps unchanged.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::net::IpAddr;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use game_core::{Conn, Outbound, OutboundSink, Persistence, Role, RoomHost, RoomKey, RoomSnapshot};

/// One serialized outbound message drained to JS. The room produces three `Outbound` shapes; the sink
/// flattens them into a single tagged form the JS side can dispatch without knowing about `Arc`s: a JSON
/// `ServerMsg` (the per-player `One` + the fan-out `Frame`, already the wire shape) or the binary snapshot
/// blob (`Binary`). `kind` lets the loop route a snapshot to the binary decoder and everything else to the
/// JSON message handler, exactly as the WebSocket client splits text vs binary frames today.
pub enum DrainedMessage {
    /// A JSON `ServerMsg` (welcome, roster, edit, chat, room-state, …) — the wire text frame.
    Json(String),
    /// The compact per-tick snapshot blob — the wire binary frame.
    Binary(Vec<u8>),
}

/// A queue-backed `OutboundSink`: the room pushes each `Outbound` here and the JS side drains it once per
/// frame. `Rc<RefCell<..>>` (not `Arc<Mutex>`) because wasm is single-threaded; the shared handle lets the
/// `WasmCore` read the same queue the room writes through its `Conn`. `id` is a unique per-connection
/// counter for the reconnect-grace identity check (a resume must tell a fresh socket from a stale one).
#[derive(Clone)]
pub struct WasmSink {
    queue: Rc<RefCell<VecDeque<Outbound>>>,
    id: u64,
}

// The room requires `Conn: OutboundSink + Send + Sync`. On single-threaded wasm there are no other
// threads, so the `Rc`-backed sink is never actually shared across threads; these asserts let it satisfy
// the bound. SAFETY: wasm32 is single-threaded and the room, sink, and JS host all run on that one thread.
unsafe impl Send for WasmSink {}
unsafe impl Sync for WasmSink {}

static NEXT_SINK_ID: AtomicU64 = AtomicU64::new(1);

impl WasmSink {
    pub fn new() -> Self {
        Self {
            queue: Rc::new(RefCell::new(VecDeque::new())),
            id: NEXT_SINK_ID.fetch_add(1, Ordering::Relaxed),
        }
    }

    /// A clone that shares the SAME underlying queue + id, so the `WasmCore` can drain what the room
    /// wrote through its `Conn`. Cloning keeps the id (mirroring the native sink), so the reconnect-grace
    /// identity check still treats both handles as the one connection.
    pub fn handle(&self) -> Self {
        self.clone()
    }

    /// Drain every queued message, flattening each `Outbound` into its JSON or binary wire form.
    pub fn drain(&self) -> Vec<DrainedMessage> {
        self.queue
            .borrow_mut()
            .drain(..)
            .map(flatten_outbound)
            .collect()
    }

    /// How many messages are currently queued (used by the native tests to assert the room produced output).
    pub fn len(&self) -> usize {
        self.queue.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.borrow().is_empty()
    }
}

impl Default for WasmSink {
    fn default() -> Self {
        Self::new()
    }
}

impl OutboundSink for WasmSink {
    fn send(&self, msg: Outbound) {
        self.queue.borrow_mut().push_back(msg);
    }
    fn id(&self) -> u64 {
        self.id
    }
}

fn flatten_outbound(msg: Outbound) -> DrainedMessage {
    match msg {
        Outbound::One(server_msg) => DrainedMessage::Json(
            serde_json::to_string(&server_msg).expect("ServerMsg serializes to JSON"),
        ),
        Outbound::Frame(frame) => DrainedMessage::Json(frame.to_string()),
        Outbound::Binary(bytes) => DrainedMessage::Binary(bytes.to_vec()),
    }
}

/// A no-op `Persistence`: offline keeps no database, so every in-game write side-effect (playtime,
/// chat log, leaderboard, world flush) is dropped — a restart loses everything, by design.
pub struct NoPersistence;

impl Persistence for NoPersistence {
    fn accrue_playtime(&self, _: &str, _: &str, _: i64, _: i64, _: i64) {}
    fn record_chat(&self, _: &str, _: &str, _: &str) {}
    fn submit_score(&self, _: &str, _: i64) {}
    fn reset_scores(&self, _: &str) {}
    fn clear_history(&self, _: &str) {}
    fn flush_world(&self, _: &str, _: Vec<u8>) {}
}

/// The in-memory `RoomHost` for a single-player offline world: ids come from a counter, and there are no
/// real bans or account claims offline (the lone local player is always the holder), so the moderation
/// surface is trivially permissive. The admin-config "writes" + admin-broadcast refreshes are no-ops —
/// offline has one client (the player, who is the admin, like the web `grantOfflineAdmin`), so there is
/// nothing to persist and no second admin to notify.
pub struct WasmHost {
    next_id: AtomicU32,
    /// The lone local player's account id, so `claim_is_live` reports their own claim as live
    /// (kick-on-reclaim can therefore never fire offline). Empty for a guest.
    local_account_id: String,
    local_claim: String,
}

impl WasmHost {
    pub fn new(local_account_id: String, local_claim: String) -> Self {
        Self {
            next_id: AtomicU32::new(1),
            local_account_id,
            local_claim,
        }
    }
}

// Same single-threaded wasm rationale as `WasmSink`: the host is only ever touched on the one wasm thread.
unsafe impl Send for WasmHost {}
unsafe impl Sync for WasmHost {}

impl RoomHost for WasmHost {
    fn alloc_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
    fn is_banned(&self, _ip: IpAddr) -> bool {
        false
    }
    fn ban(&self, _ip: IpAddr, _name: String) {}
    fn unban(&self, _ip: IpAddr) -> bool {
        false
    }
    fn list_named_bans(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    fn claim_is_live(&self, account_id: &str, token: &str) -> bool {
        !self.local_account_id.is_empty()
            && account_id == self.local_account_id
            && token == self.local_claim
    }
    fn publish_stats(&self, _key: RoomKey, _snapshot: RoomSnapshot) {}
    fn set_tenant_peace(&self, _tenant: String, _on: bool) {}
    fn set_tenant_pvp(&self, _tenant: String, _on: bool) {}
    fn set_tenant_chat(&self, _tenant: String, _on: bool) {}
    fn set_tenant_blocked_structures(&self, _tenant: String, _kinds: Vec<String>) {}
    fn set_role(&self, _account_id: String, _role: Role) {}
    fn set_tenant_suspended(&self, _tenant: String, _on: bool) {}
    fn set_tenant_approval_required(&self, _tenant: String, _on: bool) {}
    fn set_tenant_playtime(&self, _tenant: String, _limit_min: u32, _window_h: u32) {}
    fn set_tenant_modes(&self, _tenant: String, _online_allowed: bool, _offline_allowed: bool) {}
    fn refresh_pending_for_admins(&self, _tenant: String, _admin_conns: Vec<Conn>) {}
    fn approve_then_refresh(&self, _tenant: String, _account_id: String, _admin_conns: Vec<Conn>) {}
    fn reject_then_refresh(&self, _tenant: String, _account_id: String, _admin_conns: Vec<Conn>) {}
    fn clear_request_then_refresh(
        &self,
        _tenant: String,
        _account_id: String,
        _admin_conns: Vec<Conn>,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::Outbound;
    use protocol::ServerMsg;
    use std::sync::Arc;

    #[test]
    fn sink_queues_and_drains_in_order_flattening_each_shape() {
        let sink = WasmSink::new();
        let shared = sink.handle();
        assert!(sink.is_empty());

        sink.send(Outbound::One(ServerMsg::Left { id: 7 }));
        sink.send(Outbound::Frame(Arc::from("{\"t\":\"roster\"}")));
        sink.send(Outbound::Binary(Arc::from(vec![1u8, 2, 3].as_slice())));

        // The shared handle sees the same queue the room wrote through.
        assert_eq!(shared.len(), 3);

        let drained = shared.drain();
        assert_eq!(drained.len(), 3);
        assert!(
            matches!(&drained[0], DrainedMessage::Json(j) if j.contains("\"left\"") && j.contains("\"id\":7"))
        );
        assert!(matches!(&drained[1], DrainedMessage::Json(j) if j == "{\"t\":\"roster\"}"));
        assert!(matches!(&drained[2], DrainedMessage::Binary(b) if b == &[1, 2, 3]));

        // Drain consumes; a second drain is empty.
        assert!(sink.is_empty());
        assert!(shared.drain().is_empty());
    }

    #[test]
    fn sink_ids_are_unique_per_connection_but_stable_across_clones() {
        let a = WasmSink::new();
        let b = WasmSink::new();
        assert_ne!(a.id(), b.id());
        // A clone keeps the id so the reconnect-grace identity check treats both as one connection.
        assert_eq!(a.id(), a.handle().id());
    }

    #[test]
    fn host_allocs_ascending_ids() {
        let host = WasmHost::new(String::new(), String::new());
        assert_eq!(host.alloc_id(), 1);
        assert_eq!(host.alloc_id(), 2);
        assert_eq!(host.alloc_id(), 3);
    }

    #[test]
    fn host_has_no_bans_and_owns_the_local_claim() {
        let host = WasmHost::new("acc-local".into(), "tok-local".into());
        assert!(!host.is_banned("127.0.0.1".parse().unwrap()));
        assert!(host.list_named_bans().is_empty());
        // The local player's own claim is live, so kick-on-reclaim never fires offline.
        assert!(host.claim_is_live("acc-local", "tok-local"));
        // A different token or unknown account is not live.
        assert!(!host.claim_is_live("acc-local", "other-tok"));
        assert!(!host.claim_is_live("someone-else", "tok-local"));
    }

    #[test]
    fn guest_host_has_no_live_claim() {
        let host = WasmHost::new(String::new(), String::new());
        assert!(!host.claim_is_live("", ""));
    }

    #[test]
    fn no_persistence_is_inert() {
        let p = NoPersistence;
        // Every method is a no-op; the point is just that calling them does nothing observable.
        p.accrue_playtime("t", "k", 1000, 60_000, 0);
        p.record_chat("t", "name", "hi");
        p.submit_score("acc", 10);
        p.reset_scores("t");
        p.flush_world("t", vec![1, 2, 3]);
    }

    /// The native stand-in for the wasm smoke test (the `#[wasm_bindgen]` `WasmCore` it mirrors is
    /// wasm-only, and a real browser test needs a browser): drive a REAL `game_core::Room` through the
    /// three in-memory impls — add the admin player, tick a few times, drain — and prove the seam produced
    /// a Welcome (the join handshake) plus per-tick snapshots, all without any db or socket.
    #[test]
    fn room_over_inmemory_seam_emits_welcome_then_snapshots() {
        use game_core::time::Instant;
        use game_core::{playtime_key, Admission, Appearance, Conn, Role, Room, RoomConfig};
        use std::net::Ipv4Addr;
        use std::sync::atomic::AtomicU32;

        let sink = WasmSink::new();
        let drain = sink.handle();
        let host = Arc::new(WasmHost::new("offline:demo".into(), "offline:demo".into()));
        let config = RoomConfig {
            tenant: "demo".into(),
            world: "main".into(),
            brand_name: "Demo".into(),
            brand_image: String::new(),
            tick_hz: 20,
            max_players: 10,
            idle_secs: 45,
            edit_reach: 9.0,
            max_speed: 18.0,
            move_per_sec: 40.0,
            edit_per_sec: 25.0,
            chat_per_sec: 2.0,
        };
        let mut room = Room::new(config, Arc::new(NoPersistence), host);
        room.reseed(42);

        let ip = Ipv4Addr::LOCALHOST.into();
        let conn: Conn = Arc::new(sink.handle());
        let id = room.add_player(
            Instant::now(),
            Admission {
                account_id: "offline:demo".into(),
                name: String::new(),
                role: Role::Admin,
                claim: "offline:demo".into(),
                look: Appearance {
                    skin: "#f2c18b".into(),
                    shirt: "#ff5d2e".into(),
                    hair: "#3a2a1a".into(),
                },
                ip,
                observer: false,
                ping: Arc::new(AtomicU32::new(0)),
                playtime_key: playtime_key("offline:demo", ip),
                playtime_baseline_ms: 0,
                backlog: Vec::new(),
                admin_pending: Some(Some(Vec::new())),
            },
            conn,
        );
        assert_eq!(id, 1);

        // The join produced a Welcome (the first message), and nothing here is binary yet.
        let join = drain.drain();
        assert!(!join.is_empty(), "join should produce outbound messages");
        let first = match &join[0] {
            DrainedMessage::Json(j) => j,
            DrainedMessage::Binary(_) => panic!("first join message should be JSON Welcome"),
        };
        assert!(
            first.contains("\"welcome\"") && first.contains(&format!("\"you\":{id}")),
            "first join message must be the Welcome for this player, got: {first}"
        );

        // Tick a couple of frames; the per-tick snapshot is a binary blob.
        for frame in 1..=3u32 {
            room.tick_at(Instant::now(), 1.0 / 20.0);
            let _ = frame;
        }
        let ticked = drain.drain();
        let snapshots = ticked
            .iter()
            .filter(|m| matches!(m, DrainedMessage::Binary(_)))
            .count();
        assert!(
            snapshots >= 1,
            "ticking should emit at least one binary snapshot, got {} messages",
            ticked.len()
        );
    }
}
