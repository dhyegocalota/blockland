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
use crate::room::RoomCmd;

const MAX_TEXT_BYTES: usize = 4096;
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn handle(socket: WebSocket, hub: Arc<Hub>, ip: IpAddr) {
    if hub.bans.is_banned(ip) {
        let mut s = socket;
        let _ = s
            .send(text_msg(err_json(
                "banned",
                "Your access has been revoked.",
            )))
            .await;
        let _ = s.send(Message::Close(None)).await;
        tracing::debug!(%ip, "banned connection rejected");
        return;
    }
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

    let (conn_tx, mut conn_rx) = mpsc::channel::<ServerMsg>(256);
    let (reply_tx, reply_rx) = oneshot::channel();
    if room_tx
        .send(RoomCmd::Join {
            name,
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
                .send(text_msg(err_json(&code, "Room full or unavailable.")))
                .await;
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
        Err(_) => {
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
    };

    // Writer task: drains the room's outbound channel into the socket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = conn_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(txt) => {
                    if sink.send(text_msg(txt)).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sink.send(Message::Close(None)).await;
    });

    // Reader loop: forward validated client messages to the room.
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
            Message::Close(_) => break,
            _ => {}
        }
    }

    tracing::debug!(id = %pid, "player leaving");
    let _ = room_tx.send(RoomCmd::Leave { id: pid }).await;
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
