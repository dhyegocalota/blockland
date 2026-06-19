//! One authoritative room per (tenant, world). Runs a fixed-rate tick, owns the world
//! state, validates every client input, and broadcasts snapshots. The server is the
//! single source of truth; clients predict locally and reconcile from snapshots.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{Brand, ClientMsg, EditCell, EditOp, PlayerId, PlayerState, ServerMsg};
use sim::World;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::hub::{Hub, PlayerInfo, RoomKey, RoomSnapshot, TenantCfg};

// Bulk edits (magic structures, and the world handed to a joining player) are capped so one player
// cannot flood the room or build across the whole map.
const MAX_BATCH_EDITS: usize = 8192;
const BATCH_RADIUS: f32 = 48.0;
// Cells per outgoing EditBatch frame, matching the client; keeps each message under the text cap.
const BATCH_CHUNK_SIZE: usize = 256;

/// Cosmetic look a player picks before joining (validated server-side, broadcast to everyone).
pub struct Appearance {
    pub skin: String,
    pub shirt: String,
    pub hair: String,
}

pub enum RoomCmd {
    Join {
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    },
    Input {
        id: PlayerId,
        msg: ClientMsg,
    },
    Leave {
        id: PlayerId,
    },
}

/// Simple token bucket; refilled every tick, spent per accepted message.
struct Bucket {
    tokens: f32,
    cap: f32,
    refill_per_sec: f32,
}

impl Bucket {
    fn new(rate: f32) -> Self {
        Self {
            tokens: rate,
            cap: rate,
            refill_per_sec: rate,
        }
    }
    fn refill(&mut self, dt: f32) {
        self.tokens = (self.tokens + self.refill_per_sec * dt).min(self.cap);
    }
    fn take(&mut self) -> bool {
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

struct Player {
    id: PlayerId,
    name: String,
    // The trimmed username this player claimed (empty for an anonymous guest) and the live session
    // token that proves it. Together they let the tick loop kick a player whose claim was taken over.
    claim_name: String,
    claim: String,
    skin: String,
    shirt: String,
    hair: String,
    ip: IpAddr,
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    pitch: f32,
    ping_ms: u32,
    conn: mpsc::Sender<ServerMsg>,
    last_seen: Instant,
    last_move: Instant,
    joined_at_ms: u64,
    ping_nonce: u32,
    ping_sent_at: Instant,
    move_b: Bucket,
    edit_b: Bucket,
    chat_b: Bucket,
}

pub struct Room {
    hub: Arc<Hub>,
    key: RoomKey,
    brand: Brand,
    tick_hz: u32,
    max_players: usize,
    world: World,
    players: HashMap<PlayerId, Player>,
    rx: mpsc::Receiver<RoomCmd>,
    tick: u64,
    empty_since: Option<Instant>,
    dirty: bool,
}

const PING_EVERY_TICKS: u64 = 40; // 2s @ 20Hz
const EMPTY_ROOM_TTL: Duration = Duration::from_secs(30);
const PERSIST_SECS: u64 = 10; // flush the world diff at most this often, only when dirty

impl Room {
    pub fn new(
        hub: Arc<Hub>,
        tcfg: &TenantCfg,
        world: String,
        rx: mpsc::Receiver<RoomCmd>,
    ) -> Self {
        let brand = Brand {
            name: tcfg.name.clone(),
            primary: tcfg.primary.clone(),
            logo: tcfg.logo.clone(),
        };
        // Restore the tenant's persisted world (procedural base + saved edits).
        let mut world_state = World::new();
        if let Some(blob) = crate::persistence::load(&tcfg.id) {
            match sim::decode_edits(&blob) {
                Ok(items) => {
                    world_state.load_edits(&items);
                    tracing::info!(tenant = %tcfg.id, edits = items.len(), "world restored");
                }
                Err(e) => {
                    tracing::error!(tenant = %tcfg.id, error = %e, "failed to decode world blob")
                }
            }
        }
        Self {
            key: (tcfg.id.clone(), world),
            brand,
            tick_hz: hub.limits.tick_hz,
            max_players: hub.limits.max_players_per_room,
            world: world_state,
            players: HashMap::new(),
            rx,
            tick: 0,
            empty_since: Some(Instant::now()),
            dirty: false,
            hub,
        }
    }

    pub async fn run(mut self) {
        let dt = 1.0 / self.tick_hz as f32;
        let mut interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / self.tick_hz as f64));
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !self.tick(dt) {
                        break;
                    }
                }
                cmd = self.rx.recv() => {
                    match cmd {
                        Some(c) => self.handle(c),
                        None => break,
                    }
                }
            }
        }
        // Final synchronous save so nothing is lost when the room closes.
        if self.dirty {
            let blob = sim::encode_edits(&self.world.snapshot());
            if let Err(e) = crate::persistence::save(&self.key.0, &blob) {
                tracing::error!(tenant = %self.key.0, error = %e, "final world save failed");
            }
        }
        self.hub.remove_room(&self.key);
        tracing::info!(tenant = %self.key.0, world = %self.key.1, "room closed");
    }

    fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::Join {
                name,
                claim,
                look,
                ip,
                conn,
                reply,
            } => self.on_join(name, claim, look, ip, conn, reply),
            RoomCmd::Input { id, msg } => self.on_input(id, msg),
            RoomCmd::Leave { id } => {
                if self.players.remove(&id).is_some() {
                    self.broadcast(&ServerMsg::Left { id });
                }
            }
        }
    }

    fn on_join(
        &mut self,
        name: String,
        claim: String,
        look: Appearance,
        ip: IpAddr,
        conn: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        if self.hub.bans.is_banned(ip) {
            let _ = reply.send(Err("banned".into()));
            return;
        }
        if self.players.len() >= self.max_players {
            let _ = reply.send(Err("room_full".into()));
            return;
        }
        // Identity: an empty name is an anonymous guest (the server names them). A non-empty name
        // must present the live claim for (tenant, name); otherwise the handshake is rejected.
        let chosen = name.trim().to_string();
        let held = self.hub.claims.get(&self.key.0, &chosen);
        let claim_valid = !claim.is_empty() && held.as_deref() == Some(claim.as_str());
        if !chosen.is_empty() && !claim_valid {
            tracing::debug!(tenant = %self.key.0, name = %chosen, "join rejected: claim required");
            let _ = reply.send(Err("claim_required".into()));
            return;
        }
        let id = self.hub.alloc_id();
        let spawn = World::spawn();
        let limits = &self.hub.limits;
        let now = Instant::now();
        let player = Player {
            id,
            name: sanitize_name(&name),
            claim_name: chosen,
            claim,
            skin: sanitize_color(&look.skin, "#f2c18b"),
            shirt: sanitize_color(&look.shirt, "#ff5d2e"),
            hair: sanitize_color(&look.hair, "#3a2a1a"),
            ip,
            x: spawn[0],
            y: spawn[1],
            z: spawn[2],
            yaw: 0.0,
            pitch: 0.0,
            ping_ms: 0,
            conn: conn.clone(),
            last_seen: now,
            last_move: now,
            joined_at_ms: epoch_ms(),
            ping_nonce: 0,
            ping_sent_at: now,
            move_b: Bucket::new(limits.move_per_sec),
            edit_b: Bucket::new(limits.edit_per_sec),
            chat_b: Bucket::new(limits.chat_per_sec),
        };
        let welcome = ServerMsg::Welcome {
            you: id,
            tenant: self.key.0.clone(),
            world: self.key.1.clone(),
            brand: self.brand.clone(),
            tick_hz: self.tick_hz,
            spawn,
        };
        let _ = conn.try_send(welcome);
        // Hand the joining player the world that has already been built.
        let edits: Vec<EditCell> = self
            .world
            .snapshot()
            .into_iter()
            .map(|(x, y, z, block)| EditCell { x, y, z, id: block })
            .collect();
        for chunk in edits.chunks(BATCH_CHUNK_SIZE) {
            let _ = conn.try_send(ServerMsg::EditBatch {
                edits: chunk.to_vec(),
                by: 0,
            });
        }
        self.players.insert(id, player);
        self.empty_since = None;
        let _ = reply.send(Ok(id));
        tracing::info!(tenant = %self.key.0, world = %self.key.1, %id, "player joined");
    }

    fn on_input(&mut self, id: PlayerId, msg: ClientMsg) {
        let reach = self.hub.limits.edit_reach;
        let max_speed = self.hub.limits.max_speed;
        let now = Instant::now();

        // Edits and chat need a broadcast after the borrow ends, so stage them.
        let mut edit_out: Option<ServerMsg> = None;
        let mut chat_out: Option<ServerMsg> = None;
        let mut batch_out: Option<ServerMsg> = None;

        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.last_seen = now;

        match msg {
            ClientMsg::Move {
                x,
                y,
                z,
                yaw,
                pitch,
            } => {
                if !p.move_b.take() {
                    return;
                }
                let dt = (now - p.last_move).as_secs_f32().clamp(0.001, 0.5);
                p.last_move = now;
                let (dx, dy, dz) = (x - p.x, y - p.y, z - p.z);
                let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                let allowed = max_speed * dt + 2.0;
                let horizontal = 0.0..=sim::WORLD_SIZE as f32;
                let in_world = horizontal.contains(&x)
                    && horizontal.contains(&z)
                    && (0.0..=sim::MAX_FLY_Y as f32).contains(&y);
                if dist <= allowed && in_world && x.is_finite() && y.is_finite() && z.is_finite() {
                    p.x = x;
                    p.y = y;
                    p.z = z;
                    p.yaw = yaw;
                    p.pitch = pitch;
                } else {
                    tracing::debug!(id = %id, dist, allowed, "move rejected by anti-cheat");
                }
                // Out-of-bounds / too-fast moves are dropped: the next snapshot carries
                // the authoritative position and the client reconciles.
            }
            ClientMsg::Edit {
                op,
                x,
                y,
                z,
                id: block,
            } => {
                if !p.edit_b.take() {
                    return;
                }
                if !(0..sim::SIZE_Y).contains(&y) {
                    return;
                }
                let cx = x as f32 + 0.5;
                let cy = y as f32 + 0.5;
                let cz = z as f32 + 0.5;
                let d = ((cx - p.x).powi(2) + (cy - p.y).powi(2) + (cz - p.z).powi(2)).sqrt();
                if d > reach {
                    return;
                }
                let new_id = match op {
                    EditOp::Break => sim::AIR,
                    EditOp::Place => {
                        if block == 0 || block > sim::MAX_BLOCK {
                            return;
                        }
                        block
                    }
                };
                edit_out = Some(ServerMsg::Edit {
                    x,
                    y,
                    z,
                    id: new_id,
                    by: id,
                });
            }
            ClientMsg::Chat { text } => {
                if !p.chat_b.take() {
                    return;
                }
                let text = text.chars().take(160).collect::<String>();
                if text.trim().is_empty() {
                    return;
                }
                chat_out = Some(ServerMsg::Chat {
                    from: id,
                    name: p.name.clone(),
                    text,
                });
            }
            ClientMsg::EditBatch { edits } => {
                if !p.edit_b.take() || edits.len() > MAX_BATCH_EDITS {
                    return;
                }
                let applied: Vec<EditCell> = edits
                    .into_iter()
                    .filter(|c| (0..sim::SIZE_Y).contains(&c.y) && c.id <= sim::MAX_BLOCK)
                    .filter(|c| {
                        (c.x as f32 + 0.5 - p.x).abs() <= BATCH_RADIUS
                            && (c.z as f32 + 0.5 - p.z).abs() <= BATCH_RADIUS
                    })
                    .collect();
                if !applied.is_empty() {
                    batch_out = Some(ServerMsg::EditBatch {
                        edits: applied,
                        by: id,
                    });
                }
            }
            ClientMsg::Pong { nonce } => {
                if nonce == p.ping_nonce {
                    p.ping_ms = (now - p.ping_sent_at).as_millis().min(u32::MAX as u128) as u32;
                }
            }
            ClientMsg::Join { .. } => { /* already joined; ignore */ }
        }

        if let Some(ServerMsg::Edit {
            x, y, z, id: nid, ..
        }) = edit_out.as_ref()
        {
            self.world.set(*x, *y, *z, *nid);
            self.dirty = true;
            tracing::debug!(x = *x, y = *y, z = *z, id = *nid, by = %id, "edit applied");
        }
        if let Some(m) = edit_out {
            self.broadcast(&m);
        }
        if let Some(ServerMsg::EditBatch { edits, .. }) = batch_out.as_ref() {
            for c in edits {
                self.world.set(c.x, c.y, c.z, c.id);
            }
            self.dirty = true;
            tracing::debug!(count = edits.len(), by = %id, "edit batch applied");
        }
        if let Some(m) = batch_out {
            self.broadcast(&m);
        }
        if let Some(m) = chat_out {
            self.broadcast(&m);
        }
    }

    fn tick(&mut self, dt: f32) -> bool {
        self.tick += 1;

        // Refill rate buckets and find idle players to drop.
        let idle = Duration::from_secs(self.hub.limits.idle_secs);
        let now = Instant::now();
        let mut kicked: Vec<PlayerId> = Vec::new();
        for p in self.players.values_mut() {
            p.move_b.refill(dt);
            p.edit_b.refill(dt);
            p.chat_b.refill(dt);
            if self.hub.bans.is_banned(p.ip) {
                let _ = p.conn.try_send(ServerMsg::Error {
                    code: "banned".into(),
                    msg: "Your access has been revoked.".into(),
                });
                tracing::debug!(id = %p.id, ip = %p.ip, "banned kick");
                kicked.push(p.id);
                continue;
            }
            // Kick-on-reclaim: a named player whose claim is no longer the live one (someone re-claimed
            // the username) is dropped. Guests (no claim name) are never affected.
            let still_holds = self.hub.claims.get(&self.key.0, &p.claim_name).as_deref()
                == Some(p.claim.as_str());
            if !p.claim_name.is_empty() && !still_holds {
                let _ = p.conn.try_send(ServerMsg::Error {
                    code: "reclaimed".into(),
                    msg: "Your username was taken over from another device.".into(),
                });
                tracing::debug!(id = %p.id, name = %p.claim_name, "reclaimed kick");
                kicked.push(p.id);
                continue;
            }
            if now.duration_since(p.last_seen) > idle {
                let _ = p.conn.try_send(ServerMsg::Error {
                    code: "idle_timeout".into(),
                    msg: "You were idle for too long.".into(),
                });
                tracing::debug!(id = %p.id, "idle kick");
                kicked.push(p.id);
            }
        }
        for id in kicked {
            self.players.remove(&id);
            self.broadcast(&ServerMsg::Left { id });
        }

        // Server-initiated ping for authoritative latency measurement.
        if self.tick.is_multiple_of(PING_EVERY_TICKS) {
            for p in self.players.values_mut() {
                p.ping_nonce = p.ping_nonce.wrapping_add(1);
                p.ping_sent_at = now;
                let _ = p.conn.try_send(ServerMsg::Ping {
                    nonce: p.ping_nonce,
                });
            }
        }

        // Broadcast the world snapshot.
        let states: Vec<PlayerState> = self
            .players
            .values()
            .map(|p| PlayerState {
                id: p.id,
                name: p.name.clone(),
                skin: p.skin.clone(),
                shirt: p.shirt.clone(),
                hair: p.hair.clone(),
                x: p.x,
                y: p.y,
                z: p.z,
                yaw: p.yaw,
                pitch: p.pitch,
                ping_ms: p.ping_ms,
            })
            .collect();
        let snap = ServerMsg::Snapshot {
            tick: self.tick,
            players: states,
        };
        self.broadcast(&snap);

        self.publish_stats(now);

        // Persist the world diff at most every PERSIST_SECS, and only when it changed.
        if self.tick.is_multiple_of(PERSIST_SECS * self.tick_hz as u64) {
            self.flush();
        }

        // Garbage-collect an empty room after a grace period.
        if self.players.is_empty() {
            let since = *self.empty_since.get_or_insert(now);
            if now.duration_since(since) > EMPTY_ROOM_TTL {
                return false;
            }
        } else {
            self.empty_since = None;
        }
        true
    }

    fn broadcast(&self, msg: &ServerMsg) {
        for p in self.players.values() {
            let _ = p.conn.try_send(msg.clone());
        }
    }

    /// Save the world diff off the tick thread (only when it changed).
    fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let tenant = self.key.0.clone();
        let blob = sim::encode_edits(&self.world.snapshot());
        tracing::debug!(tenant = %tenant, edits = self.world.edit_count(), bytes = blob.len(), "world flush");
        tokio::task::spawn_blocking(move || {
            if let Err(e) = crate::persistence::save(&tenant, &blob) {
                tracing::error!(%tenant, error = %e, "world save failed");
            }
        });
    }

    fn publish_stats(&self, now: Instant) {
        let players = self
            .players
            .values()
            .map(|p| PlayerInfo {
                id: p.id,
                name: p.name.clone(),
                x: p.x,
                y: p.y,
                z: p.z,
                ping_ms: p.ping_ms,
                idle_ms: now.duration_since(p.last_seen).as_millis() as u64,
                joined_at_ms: p.joined_at_ms,
            })
            .collect();
        self.hub.room_stats.insert(
            self.key.clone(),
            RoomSnapshot {
                tenant: self.key.0.clone(),
                world: self.key.1.clone(),
                tick: self.tick,
                edits: self.world.edit_count(),
                players,
            },
        );
    }
}

fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '_' || *c == '-')
        .take(16)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Player".into()
    } else {
        trimmed.to_string()
    }
}

// Accept only a `#rrggbb` hex color; fall back to the given default for anything else (cosmetic).
fn sanitize_color(raw: &str, default: &str) -> String {
    let ok =
        raw.len() == 7 && raw.starts_with('#') && raw[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        raw.to_lowercase()
    } else {
        default.to_string()
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_limits_and_refills() {
        // capacity 3: three takes succeed, fourth fails until refilled.
        let mut b = Bucket::new(3.0);
        assert!(b.take());
        assert!(b.take());
        assert!(b.take());
        assert!(!b.take(), "bucket should be empty");
        b.refill(1.0); // 1s at 3/s -> +3 tokens (capped at 3)
        assert!(b.take());
    }

    #[test]
    fn bucket_caps_at_capacity() {
        let mut b = Bucket::new(2.0);
        b.refill(100.0); // huge refill must not exceed capacity
        assert!(b.take());
        assert!(b.take());
        assert!(!b.take());
    }

    #[test]
    fn sanitize_trims_and_limits() {
        assert_eq!(sanitize_name("  Teo123  "), "Teo123");
        assert_eq!(sanitize_name(""), "Player");
        assert_eq!(sanitize_name("!@#$%"), "Player");
        assert_eq!(sanitize_name("abcdefghijklmnopqrstuvwxyz").len(), 16);
        assert_eq!(sanitize_name("<script>"), "script");
    }
}
