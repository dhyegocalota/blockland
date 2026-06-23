//! Per-connection WebSocket handling: enforce the per-IP cap, wait for a `Join`, wire the
//! socket to its room, then pump messages both ways. The room owns all game logic.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientMsg, ServerMsg};
use tokio::sync::{mpsc, oneshot};

use crate::hub::Hub;
use crate::room::{Appearance, Outbound, RoomCmd};

// Large enough for a chunked EditBatch (the client caps each batch to BATCH_CHUNK cells).
const MAX_TEXT_BYTES: usize = 32 * 1024;
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);

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

    // First message must be a Join, within a timeout.
    let join = match tokio::time::timeout(JOIN_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) if t.len() <= MAX_TEXT_BYTES => {
            serde_json::from_str::<ClientMsg>(t.as_str()).ok()
        }
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
    // Kept so the Leave below can prove it is THIS connection going away (via `same_channel`): a slow,
    // stale Leave from a socket the player already reconnected over must never freeze the live slot.
    let leave_conn = conn_tx.clone();
    let (reply_tx, reply_rx) = oneshot::channel();
    if room_tx
        .send(RoomCmd::Join {
            name,
            claim,
            look: Appearance { skin, shirt, hair },
            ip,
            conn: conn_tx,
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
    let writer = tokio::spawn(async move {
        while let Some(out) = conn_rx.recv().await {
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
        let _ = sink.send(Message::Close(None)).await;
    });

    // Reader loop: forward validated client messages to the room.
    // A WebSocket Close frame means the client left on purpose (page reload / tab close); the stream just
    // ending with no Close is an abrupt drop. The room holds the slot for reconnect only on a drop, and
    // removes the player immediately on a clean leave.
    let mut clean_close = false;
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                if t.len() > MAX_TEXT_BYTES {
                    continue;
                }
                if let Ok(cm) = serde_json::from_str::<ClientMsg>(t.as_str()) {
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
    use super::reject_message;

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
