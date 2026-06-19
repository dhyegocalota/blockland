//! One authoritative room per (tenant, world). Runs a fixed-rate tick, owns the world
//! state, validates every client input, and broadcasts snapshots. The server is the
//! single source of truth; clients predict locally and reconcile from snapshots.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protocol::{Brand, ClientMsg, EditOp, PlayerId, PlayerState, ServerMsg};
use sim::World;
use tokio::sync::{mpsc, oneshot};
use tokio::time::MissedTickBehavior;

use crate::hub::{Hub, PlayerInfo, RoomKey, RoomSnapshot, TenantCfg};

pub enum RoomCmd {
    Join {
        name: String,
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
        Self { tokens: rate, cap: rate, refill_per_sec: rate }
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
    pub fn new(hub: Arc<Hub>, tcfg: &TenantCfg, world: String, rx: mpsc::Receiver<RoomCmd>) -> Self {
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
                Err(e) => tracing::error!(tenant = %tcfg.id, error = %e, "failed to decode world blob"),
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
        let mut interval = tokio::time::interval(Duration::from_secs_f64(1.0 / self.tick_hz as f64));
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
            RoomCmd::Join { name, conn, reply } => self.on_join(name, conn, reply),
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
        conn: mpsc::Sender<ServerMsg>,
        reply: oneshot::Sender<Result<PlayerId, String>>,
    ) {
        if self.players.len() >= self.max_players {
            let _ = reply.send(Err("room_full".into()));
            return;
        }
        let id = self.hub.alloc_id();
        let spawn = World::spawn();
        let limits = &self.hub.limits;
        let now = Instant::now();
        let player = Player {
            id,
            name: sanitize_name(&name),
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

        let Some(p) = self.players.get_mut(&id) else {
            return;
        };
        p.last_seen = now;

        match msg {
            ClientMsg::Move { x, y, z, yaw, pitch } => {
                if !p.move_b.take() {
                    return;
                }
                let dt = (now - p.last_move).as_secs_f32().clamp(0.001, 0.5);
                p.last_move = now;
                let (dx, dy, dz) = (x - p.x, y - p.y, z - p.z);
                let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                let allowed = max_speed * dt + 2.0;
                let in_world = x >= 0.0
                    && x <= sim::WORLD_SIZE as f32
                    && z >= 0.0
                    && z <= sim::WORLD_SIZE as f32
                    && y > -32.0
                    && y < sim::SIZE_Y as f32 + 64.0;
                if dist <= allowed && in_world && x.is_finite() && y.is_finite() && z.is_finite() {
                    p.x = x;
                    p.y = y;
                    p.z = z;
                    p.yaw = yaw;
                    p.pitch = pitch;
                }
                // Out-of-bounds / too-fast moves are dropped: the next snapshot carries
                // the authoritative position and the client reconciles.
            }
            ClientMsg::Edit { op, x, y, z, id: block } => {
                if !p.edit_b.take() {
                    return;
                }
                if y < 0 || y >= sim::SIZE_Y {
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
                edit_out = Some(ServerMsg::Edit { x, y, z, id: new_id, by: id });
            }
            ClientMsg::Chat { text } => {
                if !p.chat_b.take() {
                    return;
                }
                let text = text.chars().take(160).collect::<String>();
                if text.trim().is_empty() {
                    return;
                }
                chat_out = Some(ServerMsg::Chat { from: id, name: p.name.clone(), text });
            }
            ClientMsg::Pong { nonce } => {
                if nonce == p.ping_nonce {
                    p.ping_ms = (now - p.ping_sent_at).as_millis().min(u32::MAX as u128) as u32;
                }
            }
            ClientMsg::Join { .. } => { /* already joined; ignore */ }
        }

        if let Some(ServerMsg::Edit { x, y, z, id: nid, .. }) = edit_out.as_ref() {
            self.world.set(*x, *y, *z, *nid);
            self.dirty = true;
        }
        if let Some(m) = edit_out {
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
            if now.duration_since(p.last_seen) > idle {
                let _ = p.conn.try_send(ServerMsg::Error {
                    code: "idle_timeout".into(),
                    msg: "You were idle for too long.".into(),
                });
                kicked.push(p.id);
            }
        }
        for id in kicked {
            self.players.remove(&id);
            self.broadcast(&ServerMsg::Left { id });
        }

        // Server-initiated ping for authoritative latency measurement.
        if self.tick % PING_EVERY_TICKS == 0 {
            for p in self.players.values_mut() {
                p.ping_nonce = p.ping_nonce.wrapping_add(1);
                p.ping_sent_at = now;
                let _ = p.conn.try_send(ServerMsg::Ping { nonce: p.ping_nonce });
            }
        }

        // Broadcast the world snapshot.
        let states: Vec<PlayerState> = self
            .players
            .values()
            .map(|p| PlayerState {
                id: p.id,
                name: p.name.clone(),
                x: p.x,
                y: p.y,
                z: p.z,
                yaw: p.yaw,
                pitch: p.pitch,
                ping_ms: p.ping_ms,
            })
            .collect();
        let snap = ServerMsg::Snapshot { tick: self.tick, players: states };
        self.broadcast(&snap);

        self.publish_stats(now);

        // Persist the world diff at most every PERSIST_SECS, and only when it changed.
        if self.tick % (PERSIST_SECS * self.tick_hz as u64) == 0 {
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
