//! Per-connection WebSocket handling: enforce the per-IP cap, wait for a `Join`, wire the
//! socket to its room, then pump messages both ways. The room owns all game logic.

use std::net::IpAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use protocol::client_codec::decode_client_msg;
use protocol::{ClientMsg, ServerMsg};
use tokio::sync::{mpsc, oneshot};

use game_core::{Appearance, Conn, Outbound};

use crate::hub::Hub;
use crate::room_io::{NativeSink, RoomCmd};

// Largest accepted client frame: large enough for a chunked EditBatch (the client caps each batch to
// BATCH_CHUNK cells). Client input is now a compact BINARY `ClientMsg` (`protocol::client_codec`), so a
// batch is even smaller than the old JSON, but the cap stays generous.
const MAX_MSG_BYTES: usize = 32 * 1024;
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
// Steady heartbeat cadence, measured ON THE CONNECTION TASK (not the room tick) so a busy room never
// inflates a player's reported ping. Matches the old tick cadence (2s) so latency reads identically.
const PING_INTERVAL: Duration = Duration::from_secs(2);

/// The outstanding ping a connection is waiting to be ponged: the nonce it last sent and when. Shared
/// between the writer task (sets it when it sends `Ping`) and the reader loop (clears the RTT into the
/// `ping_ms` atomic when the matching `Pong` arrives).
type PingState = Arc<Mutex<Option<(u32, Instant)>>>;

/// Round-trip time in whole milliseconds, clamped into the `u32` the snapshot carries. A pure helper so
/// the RTT math is unit-tested without a live socket.
fn rtt_ms(rtt: Duration) -> u32 {
    rtt.as_millis().min(u32::MAX as u128) as u32
}

/// Apply a received `Pong` to the connection's shared ping state: when its nonce matches the outstanding
/// one, store the elapsed RTT (measured to `now`) into `ping_ms` and consume the outstanding entry. A
/// non-matching nonce (stale/duplicate pong) is ignored and leaves the measured ping untouched. Returns
/// the stored RTT when it matched, for the test to assert on.
fn apply_pong(state: &PingState, ping_ms: &AtomicU32, nonce: u32, now: Instant) -> Option<u32> {
    let mut outstanding = state.lock().unwrap();
    let (sent_nonce, sent_at) = (*outstanding)?;
    if nonce != sent_nonce {
        return None;
    }
    *outstanding = None;
    let measured = rtt_ms(now.duration_since(sent_at));
    ping_ms.store(measured, Ordering::Relaxed);
    Some(measured)
}

pub async fn handle(socket: WebSocket, hub: Arc<Hub>, ip: IpAddr) {
    // The ban is enforced role-aware in the room's `admit` (where the claim has resolved to a role), so
    // a banned IP whose account is an admin/moderator — e.g. a parent sharing a banned home IP — still
    // gets in (to the in-game room and the headless lobby-admin connection alike). Here, before any Join
    // is parsed, the role is unknown, so the ban cannot be checked; the only cost is that a banned
    // ordinary player now reaches `admit` before being refused. The per-IP cap below still applies.
    if !hub.try_add_ip(ip) {
        let mut s = socket;
        let _ = s
            .send(text_msg(err_json(
                "too_many_connections",
                "Too many connections from this device.",
            )))
            .await;
        let _ = s.send(Message::Close(None)).await;
        return;
    }
    tracing::debug!(%ip, "connection accepted");
    run(socket, &hub, ip).await;
    hub.remove_ip(ip);
}

async fn run(socket: WebSocket, hub: &Arc<Hub>, ip: IpAddr) {
    let (mut sink, mut stream) = socket.split();

    // First message must be a Join (a binary `ClientMsg` frame), within a timeout.
    let join = match tokio::time::timeout(JOIN_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(b)))) if b.len() <= MAX_MSG_BYTES => decode_client_msg(&b).ok(),
        _ => None,
    };
    let Some(ClientMsg::Join {
        tenant,
        world: _,
        name,
        skin,
        shirt,
        hair,
        claim,
    }) = join
    else {
        tracing::debug!(reason = "expected_join", "handshake rejected");
        let _ = sink
            .send(text_msg(err_json("expected_join", "Invalid handshake.")))
            .await;
        let _ = sink.send(Message::Close(None)).await;
        return;
    };
    tracing::debug!(%tenant, %name, "join received");

    // One persistent world per tenant: ignore any client-provided world name.
    let world = "main";
    let room_tx = match Hub::get_or_create_room(hub, &tenant, world) {
        Ok(tx) => tx,
        Err(code) => {
            tracing::debug!(reason = %code, "handshake rejected");
            let _ = sink
                .send(text_msg(err_json(&code, "Could not join the room.")))
                .await;
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    };

    let (conn_tx, mut conn_rx) = mpsc::channel::<Outbound>(256);
    // The room sees the channel only through the `OutboundSink` trait (no tokio dependency in the game
    // logic). The native sink carries a unique connection id; the same `Arc` backs both `Join` and the
    // `Leave` below, so the room's identity check proves it is THIS connection going away (via the sink
    // id): a slow, stale Leave from a socket the player already reconnected over never freezes the live slot.
    let conn: Conn = Arc::new(NativeSink::new(conn_tx));
    let leave_conn = conn.clone();
    // Per-connection latency, measured by this task's own heartbeat (below) and read by the room into the
    // snapshot. Owning it here keeps ping a property of the SOCKET round-trip, never the room's tick load.
    let ping_ms = Arc::new(AtomicU32::new(0));
    let ping_state: PingState = Arc::new(Mutex::new(None));
    let (reply_tx, reply_rx) = oneshot::channel();
    if room_tx
        .send(RoomCmd::Join {
            name,
            claim,
            look: Appearance { skin, shirt, hair },
            ip,
            conn,
            ping: ping_ms.clone(),
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        let _ = sink.send(Message::Close(None)).await;
        return;
    }
    let pid = match reply_rx.await {
        Ok(Ok(id)) => id,
        Ok(Err(code)) => {
            let _ = sink
                .send(text_msg(err_json(&code, reject_message(&code))))
                .await;
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
        Err(_) => {
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    };

    // Writer task: drains the room's outbound channel into the socket. A fan-out JSON frame (event, …)
    // arrives already serialized — the room serialized it ONCE for the whole room — so this task sends it
    // verbatim instead of re-encoding the same JSON per connection. The hot per-tick snapshot arrives as a
    // pre-encoded binary blob and is sent as a WebSocket binary frame. Per-player messages serialize here.
    //
    // It also drives the steady ping heartbeat itself: a `select!` between the outbound channel and a fixed
    // interval, so a `Ping` goes out on time regardless of room traffic and the RTT reflects only the socket.
    let writer_ping_state = ping_state.clone();
    let writer = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(PING_INTERVAL);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut nonce: u32 = 0;
        loop {
            tokio::select! {
                out = conn_rx.recv() => {
                    let Some(out) = out else {
                        break;
                    };
                    let frame = match out {
                        Outbound::Binary(bytes) => Message::Binary(bytes.to_vec().into()),
                        Outbound::Frame(frame) => text_msg(frame.to_string()),
                        Outbound::One(msg) => match serde_json::to_string(&msg) {
                            Ok(txt) => text_msg(txt),
                            Err(_) => break,
                        },
                    };
                    if sink.send(frame).await.is_err() {
                        break;
                    }
                }
                _ = ping_interval.tick() => {
                    nonce = nonce.wrapping_add(1);
                    *writer_ping_state.lock().unwrap() = Some((nonce, Instant::now()));
                    let ping = match serde_json::to_string(&ServerMsg::Ping { nonce }) {
                        Ok(txt) => text_msg(txt),
                        Err(_) => break,
                    };
                    if sink.send(ping).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = sink.send(Message::Close(None)).await;
    });

    // Reader loop: forward validated client messages to the room.
    // A WebSocket Close frame means the client left on purpose (page reload / tab close); the stream just
    // ending with no Close is an abrupt drop. The room holds the slot for reconnect only on a drop, and
    // removes the player immediately on a clean leave.
    let mut clean_close = false;
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(b) => {
                if b.len() > MAX_MSG_BYTES {
                    continue;
                }
                if let Ok(cm) = decode_client_msg(&b) {
                    // The Pong answers THIS task's heartbeat: measure the RTT here and never forward it to
                    // the room (latency is connection-local now; the room only reads the measured atomic).
                    if let ClientMsg::Pong { nonce } = cm {
                        apply_pong(&ping_state, &ping_ms, nonce, Instant::now());
                        continue;
                    }
                    if room_tx
                        .send(RoomCmd::Input { id: pid, msg: cm })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Message::Close(_) => {
                clean_close = true;
                break;
            }
            _ => {}
        }
    }

    tracing::debug!(id = %pid, clean_close, "player leaving");
    let _ = room_tx
        .send(RoomCmd::Leave {
            id: pid,
            conn: leave_conn,
            clean: clean_close,
        })
        .await;
    writer.abort();
}

fn text_msg(s: String) -> Message {
    Message::Text(s.into())
}

fn err_json(code: &str, msg: &str) -> String {
    serde_json::to_string(&ServerMsg::Error {
        code: code.into(),
        msg: msg.into(),
    })
    .unwrap_or_else(|_| "{\"t\":\"error\",\"code\":\"internal\",\"msg\":\"\"}".into())
}

/// The single source of the user-facing message for a join rejection, keyed by its code, so a held or
/// blocked player gets the right reason (e.g. "log in" — not the old generic "Room full") and the room
/// never has to send the message itself.
fn reject_message(code: &str) -> &'static str {
    match code {
        "banned" => "You're banned from this world.",
        "room_full" => "This world is full right now.",
        "claim_required" => "Please log in to use this name.",
        "online_blocked" => "Online play is turned off for this world.",
        "suspended" => "This world is paused by a grown-up.",
        "needs_login" => "Please log in so a grown-up can let you in.",
        "rejected" => "A grown-up didn't let you in this time.",
        "needs_approval" => "Waiting for a grown-up to let you in.",
        "time_up" => "You've used your play time for now.",
        _ => "Couldn't join this world right now.",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::{apply_pong, reject_message, rtt_ms, PingState};

    #[test]
    fn rtt_ms_is_the_elapsed_millis_clamped_into_u32() {
        assert_eq!(rtt_ms(Duration::from_millis(0)), 0);
        assert_eq!(rtt_ms(Duration::from_millis(37)), 37);
        // Sub-millisecond rounds down to whole milliseconds (the wire carries whole ms).
        assert_eq!(rtt_ms(Duration::from_micros(1500)), 1);
        // An absurd RTT saturates instead of overflowing the u32 the snapshot carries.
        assert_eq!(rtt_ms(Duration::from_secs(60 * 60 * 24 * 365)), u32::MAX);
    }

    #[test]
    fn matching_pong_stores_the_measured_rtt_and_consumes_the_outstanding_nonce() {
        let sent_at = Instant::now();
        let state: PingState = Arc::new(Mutex::new(Some((7, sent_at))));
        let ping_ms = AtomicU32::new(0);
        let measured = apply_pong(&state, &ping_ms, 7, sent_at + Duration::from_millis(42));
        assert_eq!(measured, Some(42));
        assert_eq!(ping_ms.load(Ordering::Relaxed), 42);
        // The outstanding ping is consumed, so a duplicate of the same pong no longer measures.
        assert!(state.lock().unwrap().is_none());
        assert_eq!(apply_pong(&state, &ping_ms, 7, sent_at), None);
    }

    #[test]
    fn non_matching_pong_leaves_the_measured_ping_untouched() {
        let sent_at = Instant::now();
        let state: PingState = Arc::new(Mutex::new(Some((9, sent_at))));
        let ping_ms = AtomicU32::new(123);
        let measured = apply_pong(&state, &ping_ms, 8, sent_at + Duration::from_millis(500));
        assert_eq!(measured, None);
        assert_eq!(ping_ms.load(Ordering::Relaxed), 123);
        // A stale pong does not consume the outstanding nonce; the real pong can still land.
        assert_eq!(state.lock().unwrap().map(|(n, _)| n), Some(9));
    }

    #[test]
    fn pong_with_no_outstanding_ping_is_ignored() {
        let state: PingState = Arc::new(Mutex::new(None));
        let ping_ms = AtomicU32::new(50);
        assert_eq!(apply_pong(&state, &ping_ms, 1, Instant::now()), None);
        assert_eq!(ping_ms.load(Ordering::Relaxed), 50);
    }

    #[test]
    fn reject_message_is_specific_per_code_and_never_the_old_generic() {
        assert_eq!(
            reject_message("needs_login"),
            "Please log in so a grown-up can let you in."
        );
        assert_eq!(
            reject_message("needs_approval"),
            "Waiting for a grown-up to let you in."
        );
        assert_eq!(reject_message("room_full"), "This world is full right now.");
        // An unknown code gets a neutral fallback, not the misleading "Room full or unavailable.".
        assert_eq!(
            reject_message("whatever"),
            "Couldn't join this world right now."
        );
    }
}
