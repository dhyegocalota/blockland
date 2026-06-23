//! Binary codec for the hot per-tick [`crate::ServerMsg::Snapshot`]. Only this one message goes binary;
//! every other wire message stays JSON text. The web client decodes the same layout in
//! `apps/web/lib/snapshot-codec.ts`; the two are kept in lock-step by a shared hex fixture test.
//!
//! Byte layout (little-endian throughout):
//!
//! ```text
//! [0]            u8   version tag (SNAPSHOT_BINARY_VERSION)
//! [1..9]         u64  tick
//! [9..11]        u16  player count
//!   per player (fixed order, repeated `player count` times):
//!     u32 id, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, i32 pitch_cm, u32 ping_ms, u32 score, u8 hp
//! [..]           u16  creature count
//!   per creature:
//!     u32 id, u8 kind_index, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, u8 hp, u8 max_hp
//! [..]           u16  heart count
//!   per heart:
//!     u32 id, i32 x_cm, i32 y_cm, i32 z_cm
//! ```
//!
//! Floats (coords, yaw, pitch) are carried as i32 centimetres: `round(value * 100)`. The server already
//! rounds every snapshot coordinate to centimetre precision before it goes on the wire, so this is the
//! same precision as today's JSON — no information is lost relative to the current path.

use crate::{CreatureState, HeartDropState, PlayerState};

/// Version tag in byte 0; bump if the layout changes so a stale decoder rejects rather than misreads.
pub const SNAPSHOT_BINARY_VERSION: u8 = 1;

/// The fixed-point scale applied to floats before they go on the wire (centimetres). Mirrors the
/// server's `round_snapshot` precision so the binary path preserves exactly today's JSON precision.
const CM_SCALE: f32 = 100.0;

fn float_to_cm(value: f32) -> i32 {
    (value * CM_SCALE).round() as i32
}

struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn cm(&mut self, value: f32) {
        self.i32(float_to_cm(value));
    }
}

/// Encode a snapshot's fields into the binary wire form documented above.
pub fn encode_snapshot(
    tick: u64,
    players: &[PlayerState],
    creatures: &[CreatureState],
    hearts: &[HeartDropState],
) -> Vec<u8> {
    let mut writer = Writer::new();
    writer.u8(SNAPSHOT_BINARY_VERSION);
    writer.u64(tick);

    writer.u16(players.len() as u16);
    for p in players {
        writer.u32(p.0);
        writer.cm(p.1);
        writer.cm(p.2);
        writer.cm(p.3);
        writer.cm(p.4);
        writer.cm(p.5);
        writer.u32(p.6);
        writer.u32(p.7);
        writer.u8(p.8);
    }

    writer.u16(creatures.len() as u16);
    for c in creatures {
        writer.u32(c.0);
        writer.u8(c.1);
        writer.cm(c.2);
        writer.cm(c.3);
        writer.cm(c.4);
        writer.cm(c.5);
        writer.u8(c.6);
        writer.u8(c.7);
    }

    writer.u16(hearts.len() as u16);
    for h in hearts {
        writer.u32(h.0);
        writer.cm(h.1);
        writer.cm(h.2);
        writer.cm(h.3);
    }

    writer.bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A known fixed snapshot whose exact bytes are pinned below and re-decoded byte-for-byte by the
    /// TypeScript fixture test. Touch BOTH sides (and the hex) if you ever change it.
    fn fixture() -> (
        u64,
        Vec<PlayerState>,
        Vec<CreatureState>,
        Vec<HeartDropState>,
    ) {
        let tick = 1_234u64;
        let players = vec![PlayerState(1, 2.5, 64.25, -8.0, 0.31, 0.05, 20, 6, 3)];
        let creatures = vec![CreatureState(100, 4, -3.0, 63.5, 8.0, 0.2, 2, 3)];
        let hearts = vec![HeartDropState(200, -5.0, 63.5, 1.1)];
        (tick, players, creatures, hearts)
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The cross-language safety net: this EXACT hex is pasted into `snapshot-codec.test.ts`, which
    /// decodes it and asserts the same `{tick,players,creatures,hearts}` object. If this assertion's hex
    /// changes, update the TS fixture to match (and vice versa) — the two codecs must agree byte-for-byte.
    #[test]
    fn encodes_the_shared_fixture_to_exact_bytes() {
        let (tick, players, creatures, hearts) = fixture();
        let bytes = encode_snapshot(tick, &players, &creatures, &hearts);
        assert_eq!(to_hex(&bytes), FIXTURE_HEX);
    }

    #[test]
    fn encodes_empty_arrays() {
        let bytes = encode_snapshot(0, &[], &[], &[]);
        assert_eq!(to_hex(&bytes), "010000000000000000000000000000");
    }

    #[test]
    fn coords_round_to_centimetres_like_the_json_path() {
        assert_eq!(float_to_cm(1.234), 123);
        assert_eq!(float_to_cm(-1.236), -124);
    }

    #[test]
    fn many_entities_and_extreme_ids_keep_the_fixed_record_widths() {
        let players: Vec<PlayerState> = (0..300)
            .map(|i| PlayerState(u32::MAX - i, -1.5, 0.0, 99.99, -7.25, 0.0, i, i * 2, 3))
            .collect();
        let creatures: Vec<CreatureState> = (0..5)
            .map(|k| CreatureState(k, k as u8, 0.0, 0.0, 0.0, 0.0, 0, 0))
            .collect();
        let bytes = encode_snapshot(u64::MAX, &players, &creatures, &[]);
        assert_eq!(bytes.len(), 1 + 8 + 2 + 300 * 33 + 2 + 5 * 23 + 2);
        assert_eq!(bytes[0], SNAPSHOT_BINARY_VERSION);
    }

    /// Pinned exact bytes of `fixture()`. Computed by the encoder itself; the value is checked against the
    /// TypeScript decoder via the shared fixture string in `apps/web/lib/snapshot-codec.test.ts`.
    const FIXTURE_HEX: &str = "01d204000000000000010001000000fa00000019190000e0fcffff1f0000000500000014000000060000000301006400000004d4feffffce180000200300001400000002030100c80000000cfeffffce1800006e000000";
}
