//! The server-side I/O envelope around a room: the async-dispatch `RoomCmd` (it carries tokio
//! `oneshot`/`mpsc` types and the connection sink) and `NativeSink`, the tokio-backed `OutboundSink`
//! the connection task wires a real socket to. The pure game logic in `game_core` never sees these.

use std::net::IpAddr;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;

use game_core::{next_conn_id, Appearance, Conn, Outbound, OutboundSink};
use protocol::{ClientMsg, PlayerId, ServerMsg};
use tokio::sync::{mpsc, oneshot};

pub enum RoomCmd {
    Join {
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        /// A headless monitor connection (the lobby admin panel): admitted so it receives room state and
        /// can send admin commands, but kept out of the roster + snapshot so it never reads as "joined".
        observer: bool,
        conn: Conn,
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
        /// player's CURRENT connection (by sink id) and ignore a stale one from a socket already
        /// replaced by a reconnect — without it, a late Leave would freeze a live, resumed player.
        conn: Conn,
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

/// The native (tokio-backed) `OutboundSink`: a real `mpsc::Sender<Outbound>` plus a unique id. The
/// future WASM build provides its own impl over a JS-bound queue; the room only ever sees the trait.
pub struct NativeSink {
    tx: mpsc::Sender<Outbound>,
    id: u64,
}

impl NativeSink {
    pub fn new(tx: mpsc::Sender<Outbound>) -> Self {
        Self {
            tx,
            id: next_conn_id(),
        }
    }
}

impl OutboundSink for NativeSink {
    fn send(&self, msg: Outbound) {
        let _ = self.tx.try_send(msg);
    }
    fn id(&self) -> u64 {
        self.id
    }
}
