//! The room's view of a connection's outbound channel, abstracted away from any I/O runtime so the
//! game logic doesn't depend on tokio. The native server backs `OutboundSink` with a tokio mpsc sink
//! (`NativeSink`, in the server crate); a future WASM core backs it with a JS-bound queue.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use protocol::ServerMsg;

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

/// The room's view of a connection's outbound channel, abstracted away from tokio so the game logic
/// no longer depends on `mpsc` directly (a future WASM core backs this with a JS-bound queue instead).
/// `send` is non-blocking — it drops the message if the channel is full or closed, so a slow client
/// never stalls the room tick (mirroring the old `let _ = conn.try_send(..)` at every call site). `id`
/// is a unique per-connection identity used by the reconnect-grace to tell a player's CURRENT socket
/// apart from a stale one it already reconnected over (replacing the old `same_channel`).
pub trait OutboundSink {
    fn send(&self, msg: Outbound);
    fn id(&self) -> u64;
}

/// Convenience for the per-player `One` sends (welcome, inventory, error, …), so those call sites read
/// the same as before the trait extraction.
pub(crate) trait SendOne {
    fn send_one(&self, msg: ServerMsg);
}

impl SendOne for dyn OutboundSink + Send + Sync {
    fn send_one(&self, msg: ServerMsg) {
        self.send(Outbound::One(msg));
    }
}

/// Process-global source of unique connection ids, so two distinct sinks never share an identity (and a
/// clone of the SAME sink keeps it, which is what makes the reconnect-grace identity check work).
pub static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// Allocate the next unique connection id. A native `OutboundSink` impl stamps itself with this so the
/// reconnect-grace identity check can tell two distinct sockets apart.
pub fn next_conn_id() -> u64 {
    NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed)
}

/// A player's outbound channel as the room holds it: a shared trait object so a resume can clone/swap it
/// like the old `mpsc::Sender`. `Arc` so the same connection can sit in `Player.conn`, be cloned into an
/// admin-broadcast list, and back the `Leave` identity check — all without re-wrapping.
pub type Conn = Arc<dyn OutboundSink + Send + Sync>;
