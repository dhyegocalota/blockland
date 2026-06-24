//! Binary codec for the hot per-tick [`crate::ServerMsg::Snapshot`]. Only this one message goes binary;
//! every other wire message stays JSON text. The web client decodes the same layout in
//! `apps/web/lib/snapshot-codec.ts`; the two are kept in lock-step by shared hex fixture tests.
//!
//! Two frame kinds share the same entity record layout. A KEYFRAME carries the FULL snapshot; a DELTA
//! carries, against a named baseline tick, only the entities that changed/were added plus the ids that
//! were removed. The server keeps its last-sent full snapshot as the baseline, encodes ONE delta per
//! tick shared by every in-sync connection, and emits a keyframe to a just-joined/resumed connection
//! and periodically to bound the baseline. The client reconstructs the full snapshot from them.
//!
//! Byte layout (little-endian throughout):
//!
//! ```text
//! [0]            u8   version tag (SNAPSHOT_BINARY_VERSION)
//! [1]            u8   frame kind (FRAME_KEYFRAME | FRAME_DELTA)
//! [2..10]        u64  tick
//! ```
//!
//! A KEYFRAME then carries the full snapshot:
//!
//! ```text
//! u16 player count, then per player (fixed order):
//!   u32 id, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, i32 pitch_cm, u32 ping_ms, u32 score, u8 hp
//! u16 creature count, then per creature:
//!   u32 id, u8 kind_index, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, u8 hp, u8 max_hp
//! u16 heart count, then per heart:
//!   u32 id, i32 x_cm, i32 y_cm, i32 z_cm
//! ```
//!
//! A DELTA then carries the baseline it builds on and, per category, the changed/added records followed
//! by the removed ids:
//!
//! ```text
//! u64 baseline_tick
//! u16 changed player count, then that many full player records (same layout as a keyframe)
//! u16 removed player count, then that many u32 ids
//! u16 changed creature count, then that many full creature records
//! u16 removed creature count, then that many u32 ids
//! u16 changed heart count, then that many full heart records
//! u16 removed heart count, then that many u32 ids
//! ```
//!
//! An entity absent from a delta is UNCHANGED; only ids in a removed list are dropped by the client.
//!
//! Floats (coords, yaw, pitch) are carried as i32 centimetres: `round(value * 100)`. The server already
//! rounds every snapshot coordinate to centimetre precision before it goes on the wire, so this is the
//! same precision as today's JSON — no information is lost relative to the current path.

use crate::{CreatureState, HeartDropState, PlayerState};

/// Version tag in byte 0; bump if the layout changes so a stale decoder rejects rather than misreads.
pub const SNAPSHOT_BINARY_VERSION: u8 = 1;

/// Frame kind in byte 1: a full snapshot (keyframe) or a baseline-relative delta.
pub const FRAME_KEYFRAME: u8 = 0;
pub const FRAME_DELTA: u8 = 1;

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

    fn player(&mut self, p: &PlayerState) {
        self.u32(p.0);
        self.cm(p.1);
        self.cm(p.2);
        self.cm(p.3);
        self.cm(p.4);
        self.cm(p.5);
        self.u32(p.6);
        self.u32(p.7);
        self.u8(p.8);
    }

    fn creature(&mut self, c: &CreatureState) {
        self.u32(c.0);
        self.u8(c.1);
        self.cm(c.2);
        self.cm(c.3);
        self.cm(c.4);
        self.cm(c.5);
        self.u8(c.6);
        self.u8(c.7);
    }

    fn heart(&mut self, h: &HeartDropState) {
        self.u32(h.0);
        self.cm(h.1);
        self.cm(h.2);
        self.cm(h.3);
    }

    fn removed_ids(&mut self, ids: &[u32]) {
        self.u16(ids.len() as u16);
        for id in ids {
            self.u32(*id);
        }
    }
}

/// Encode the FULL snapshot as a keyframe (the entire world this tick), the frame a just-joined/resumed
/// connection and the periodic resync receive. The client replaces its state from it.
pub fn encode_keyframe(
    tick: u64,
    players: &[PlayerState],
    creatures: &[CreatureState],
    hearts: &[HeartDropState],
) -> Vec<u8> {
    let mut writer = Writer::new();
    writer.u8(SNAPSHOT_BINARY_VERSION);
    writer.u8(FRAME_KEYFRAME);
    writer.u64(tick);

    writer.u16(players.len() as u16);
    for p in players {
        writer.player(p);
    }
    writer.u16(creatures.len() as u16);
    for c in creatures {
        writer.creature(c);
    }
    writer.u16(hearts.len() as u16);
    for h in hearts {
        writer.heart(h);
    }
    writer.bytes
}

/// A borrowed view of a full snapshot at one tick — the unit `encode_delta` diffs. Keeps the delta
/// signature to two arguments (a baseline and a next) instead of eight loose slices.
pub struct SnapshotView<'a> {
    pub tick: u64,
    pub players: &'a [PlayerState],
    pub creatures: &'a [CreatureState],
    pub hearts: &'a [HeartDropState],
}

/// Encode the delta of `next` against `baseline`: the changed/added entities (any field differing, or a
/// new id) as full records, plus the ids present in the baseline but gone from `next`, per category. The
/// client applies it onto the baseline state to reconstruct the full `next` snapshot.
pub fn encode_delta(baseline: SnapshotView, next: SnapshotView) -> Vec<u8> {
    let mut writer = Writer::new();
    writer.u8(SNAPSHOT_BINARY_VERSION);
    writer.u8(FRAME_DELTA);
    writer.u64(next.tick);
    writer.u64(baseline.tick);

    let changed_players = changed(next.players, baseline.players, |p| p.0, player_eq);
    writer.u16(changed_players.len() as u16);
    for p in &changed_players {
        writer.player(p);
    }
    writer.removed_ids(&removed(baseline.players, next.players, |p| p.0));

    let changed_creatures = changed(next.creatures, baseline.creatures, |c| c.0, creature_eq);
    writer.u16(changed_creatures.len() as u16);
    for c in &changed_creatures {
        writer.creature(c);
    }
    writer.removed_ids(&removed(baseline.creatures, next.creatures, |c| c.0));

    let changed_hearts = changed(next.hearts, baseline.hearts, |h| h.0, heart_eq);
    writer.u16(changed_hearts.len() as u16);
    for h in &changed_hearts {
        writer.heart(h);
    }
    writer.removed_ids(&removed(baseline.hearts, next.hearts, |h| h.0));

    writer.bytes
}

fn changed<'a, T, Id, Eq>(next: &'a [T], baseline: &[T], id_of: Id, equal: Eq) -> Vec<&'a T>
where
    Id: Fn(&T) -> u32,
    Eq: Fn(&T, &T) -> bool,
{
    next.iter()
        .filter(
            |item| match baseline.iter().find(|b| id_of(b) == id_of(item)) {
                Some(prev) => !equal(prev, item),
                None => true,
            },
        )
        .collect()
}

fn removed<T, Id: Fn(&T) -> u32>(baseline: &[T], next: &[T], id_of: Id) -> Vec<u32> {
    baseline
        .iter()
        .map(&id_of)
        .filter(|id| !next.iter().any(|n| id_of(n) == *id))
        .collect()
}

fn player_eq(a: &PlayerState, b: &PlayerState) -> bool {
    float_record_eq(&[a.1, a.2, a.3, a.4, a.5], &[b.1, b.2, b.3, b.4, b.5])
        && a.6 == b.6
        && a.7 == b.7
        && a.8 == b.8
}

fn creature_eq(a: &CreatureState, b: &CreatureState) -> bool {
    a.1 == b.1
        && float_record_eq(&[a.2, a.3, a.4, a.5], &[b.2, b.3, b.4, b.5])
        && a.6 == b.6
        && a.7 == b.7
}

fn heart_eq(a: &HeartDropState, b: &HeartDropState) -> bool {
    float_record_eq(&[a.1, a.2, a.3], &[b.1, b.2, b.3])
}

/// Compare two records' floats at wire precision (centimetres): a sub-centimetre wobble that the wire
/// would round to identical bytes must NOT count as a change, or the delta would resend unchanged entities.
fn float_record_eq(a: &[f32], b: &[f32]) -> bool {
    a.iter()
        .zip(b)
        .all(|(x, y)| float_to_cm(*x) == float_to_cm(*y))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A known fixed snapshot whose exact keyframe bytes are pinned below and re-decoded byte-for-byte by
    /// the TypeScript fixture test. Touch BOTH sides (and the hex) if you ever change it.
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

    /// The cross-language safety net: this EXACT keyframe hex is pasted into `snapshot-codec.test.ts`,
    /// which decodes it and asserts the same `{tick,players,creatures,hearts}` object. If this assertion's
    /// hex changes, update the TS fixture to match (and vice versa) — the two codecs must agree byte-for-byte.
    #[test]
    fn encodes_the_shared_keyframe_fixture_to_exact_bytes() {
        let (tick, players, creatures, hearts) = fixture();
        let bytes = encode_keyframe(tick, &players, &creatures, &hearts);
        assert_eq!(to_hex(&bytes), KEYFRAME_FIXTURE_HEX);
    }

    #[test]
    fn encodes_empty_keyframe_arrays() {
        let bytes = encode_keyframe(0, &[], &[], &[]);
        assert_eq!(to_hex(&bytes), "01000000000000000000000000000000");
    }

    #[test]
    fn coords_round_to_centimetres_like_the_json_path() {
        assert_eq!(float_to_cm(1.234), 123);
        assert_eq!(float_to_cm(-1.236), -124);
    }

    #[test]
    fn keyframe_keeps_the_fixed_record_widths() {
        let players: Vec<PlayerState> = (0..300)
            .map(|i| PlayerState(u32::MAX - i, -1.5, 0.0, 99.99, -7.25, 0.0, i, i * 2, 3))
            .collect();
        let creatures: Vec<CreatureState> = (0..5)
            .map(|k| CreatureState(k, k as u8, 0.0, 0.0, 0.0, 0.0, 0, 0))
            .collect();
        let bytes = encode_keyframe(u64::MAX, &players, &creatures, &[]);
        assert_eq!(bytes.len(), 1 + 1 + 8 + 2 + 300 * 33 + 2 + 5 * 23 + 2);
        assert_eq!(bytes[0], SNAPSHOT_BINARY_VERSION);
        assert_eq!(bytes[1], FRAME_KEYFRAME);
    }

    #[test]
    fn delta_carries_only_changed_and_removed_entities() {
        let baseline_players = vec![
            PlayerState(1, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
            PlayerState(2, 5.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
        ];
        let baseline_creatures = vec![CreatureState(10, 0, 0.0, 0.0, 0.0, 0.0, 2, 2)];
        let baseline_hearts = vec![HeartDropState(20, 0.0, 0.0, 0.0)];

        // Player 1 moved, player 2 left, player 3 joined; the creature is unchanged; the heart left.
        let next_players = vec![
            PlayerState(1, 1.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
            PlayerState(3, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
        ];
        let next_creatures = baseline_creatures.clone();
        let next_hearts: Vec<HeartDropState> = vec![];

        let bytes = encode_delta(
            SnapshotView {
                tick: 7,
                players: &baseline_players,
                creatures: &baseline_creatures,
                hearts: &baseline_hearts,
            },
            SnapshotView {
                tick: 8,
                players: &next_players,
                creatures: &next_creatures,
                hearts: &next_hearts,
            },
        );
        let Frame::Delta(d) = decode_frame(&bytes) else {
            panic!("expected a delta frame");
        };
        assert_eq!(d.tick, 8);
        assert_eq!(d.baseline_tick, 7);
        assert_eq!(
            d.changed_players.iter().map(|p| p.0).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(d.removed_players, vec![2]);
        assert!(
            d.changed_creatures.is_empty(),
            "unchanged creature is omitted"
        );
        assert!(d.removed_creatures.is_empty());
        assert!(d.changed_hearts.is_empty());
        assert_eq!(d.removed_hearts, vec![20]);
    }

    #[test]
    fn delta_omits_a_sub_centimetre_wobble() {
        let baseline = vec![PlayerState(1, 1.0, 2.0, 3.0, 0.0, 0.0, 0, 0, 3)];
        // +1mm — below the centimetre wire precision, so it must NOT count as changed.
        let next = vec![PlayerState(1, 1.001, 2.0, 3.0, 0.0, 0.0, 0, 0, 3)];
        let bytes = encode_delta(
            SnapshotView {
                tick: 1,
                players: &baseline,
                creatures: &[],
                hearts: &[],
            },
            SnapshotView {
                tick: 2,
                players: &next,
                creatures: &[],
                hearts: &[],
            },
        );
        let Frame::Delta(d) = decode_frame(&bytes) else {
            panic!("expected a delta frame");
        };
        assert!(d.changed_players.is_empty());
    }

    /// A decoder that reconstructs the exact original sequence from a keyframe followed by deltas — the
    /// Rust-side mirror of the client apply loop. Proves the byte stream is self-sufficient to rebuild
    /// every full snapshot.
    #[test]
    fn keyframe_then_deltas_reconstruct_the_exact_sequence() {
        let frames = [
            (
                1u64,
                vec![PlayerState(1, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3)],
                vec![CreatureState(10, 0, 0.0, 0.0, 0.0, 0.0, 2, 2)],
                vec![HeartDropState(20, 0.0, 0.0, 0.0)],
            ),
            (
                2,
                vec![
                    PlayerState(1, 1.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
                    PlayerState(2, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3),
                ],
                vec![CreatureState(10, 0, 0.0, 0.0, 0.0, 0.0, 1, 2)],
                vec![],
            ),
            (
                3,
                vec![PlayerState(2, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 3)],
                vec![],
                vec![HeartDropState(21, 5.0, 0.0, 0.0)],
            ),
        ];

        let mut state = decode_full(&encode_keyframe(
            frames[0].0,
            &frames[0].1,
            &frames[0].2,
            &frames[0].3,
        ));
        assert!(full_eq(&state, &frames[0]));

        for pair in frames.windows(2) {
            let (base, next) = (&pair[0], &pair[1]);
            let bytes = encode_delta(view(base), view(next));
            let Frame::Delta(d) = decode_frame(&bytes) else {
                panic!("expected a delta frame");
            };
            assert_eq!(d.baseline_tick, state.0);
            state = apply_delta(state, d);
            assert!(
                full_eq(&state, next),
                "reconstructed tick {} mismatch",
                next.0
            );
        }
    }

    fn view(full: &Full) -> SnapshotView<'_> {
        SnapshotView {
            tick: full.0,
            players: &full.1,
            creatures: &full.2,
            hearts: &full.3,
        }
    }

    /// The shared (baseline → delta) fixture: the same baseline `fixture()` at tick 1234, then a next at
    /// tick 1235 that moves the player (x 2.5 → 3.0) and drops the heart. The TS fixture test applies the
    /// keyframe then this delta and asserts the reconstructed full snapshot — so the hex must agree.
    fn delta_fixture() -> (Full, Full) {
        let (tick, players, creatures, hearts) = fixture();
        let baseline = (tick, players, creatures, hearts);
        let next_players = vec![PlayerState(1, 3.0, 64.25, -8.0, 0.31, 0.05, 20, 6, 3)];
        let next = (1_235u64, next_players, baseline.2.clone(), vec![]);
        (baseline, next)
    }

    #[test]
    fn encodes_the_shared_delta_fixture_to_exact_bytes() {
        let (base, next) = delta_fixture();
        let bytes = encode_delta(view(&base), view(&next));
        assert_eq!(to_hex(&bytes), DELTA_FIXTURE_HEX);
    }

    /// Pinned exact bytes of `fixture()` as a KEYFRAME. Computed by the encoder itself; checked against the
    /// TypeScript decoder via the shared fixture string in `apps/web/lib/snapshot-codec.test.ts`.
    const KEYFRAME_FIXTURE_HEX: &str = "0100d204000000000000010001000000fa00000019190000e0fcffff1f0000000500000014000000060000000301006400000004d4feffffce180000200300001400000002030100c80000000cfeffffce1800006e000000";

    /// Pinned exact bytes of `delta_fixture()` as a DELTA. Pasted into the TS fixture test, which applies
    /// it onto the keyframe baseline and asserts the reconstructed full snapshot.
    const DELTA_FIXTURE_HEX: &str = "0101d304000000000000d2040000000000000100010000002c01000019190000e0fcffff1f0000000500000014000000060000000300000000000000000100c8000000";

    fn full_eq(a: &Full, b: &Full) -> bool {
        a.0 == b.0
            && a.1.len() == b.1.len()
            && a.1
                .iter()
                .zip(&b.1)
                .all(|(x, y)| x.0 == y.0 && player_eq(x, y))
            && a.2.len() == b.2.len()
            && a.2
                .iter()
                .zip(&b.2)
                .all(|(x, y)| x.0 == y.0 && creature_eq(x, y))
            && a.3.len() == b.3.len()
            && a.3
                .iter()
                .zip(&b.3)
                .all(|(x, y)| x.0 == y.0 && heart_eq(x, y))
    }

    // --- in-test reconstruction helpers (mirror the client apply loop) ---

    type Full = (
        u64,
        Vec<PlayerState>,
        Vec<CreatureState>,
        Vec<HeartDropState>,
    );

    struct DeltaFrame {
        tick: u64,
        baseline_tick: u64,
        changed_players: Vec<PlayerState>,
        removed_players: Vec<u32>,
        changed_creatures: Vec<CreatureState>,
        removed_creatures: Vec<u32>,
        changed_hearts: Vec<HeartDropState>,
        removed_hearts: Vec<u32>,
    }

    enum Frame {
        Keyframe(Full),
        Delta(DeltaFrame),
    }

    struct TestReader<'a> {
        bytes: &'a [u8],
        offset: usize,
    }

    impl<'a> TestReader<'a> {
        fn u8(&mut self) -> u8 {
            let v = self.bytes[self.offset];
            self.offset += 1;
            v
        }
        fn u16(&mut self) -> u16 {
            let v =
                u16::from_le_bytes(self.bytes[self.offset..self.offset + 2].try_into().unwrap());
            self.offset += 2;
            v
        }
        fn u32(&mut self) -> u32 {
            let v =
                u32::from_le_bytes(self.bytes[self.offset..self.offset + 4].try_into().unwrap());
            self.offset += 4;
            v
        }
        fn u64(&mut self) -> u64 {
            let v =
                u64::from_le_bytes(self.bytes[self.offset..self.offset + 8].try_into().unwrap());
            self.offset += 8;
            v
        }
        fn cm(&mut self) -> f32 {
            let v =
                i32::from_le_bytes(self.bytes[self.offset..self.offset + 4].try_into().unwrap());
            self.offset += 4;
            v as f32 / CM_SCALE
        }
        fn player(&mut self) -> PlayerState {
            PlayerState(
                self.u32(),
                self.cm(),
                self.cm(),
                self.cm(),
                self.cm(),
                self.cm(),
                self.u32(),
                self.u32(),
                self.u8(),
            )
        }
        fn creature(&mut self) -> CreatureState {
            CreatureState(
                self.u32(),
                self.u8(),
                self.cm(),
                self.cm(),
                self.cm(),
                self.cm(),
                self.u8(),
                self.u8(),
            )
        }
        fn heart(&mut self) -> HeartDropState {
            HeartDropState(self.u32(), self.cm(), self.cm(), self.cm())
        }
        fn ids(&mut self) -> Vec<u32> {
            let n = self.u16();
            (0..n).map(|_| self.u32()).collect()
        }
    }

    fn decode_frame(bytes: &[u8]) -> Frame {
        let mut r = TestReader { bytes, offset: 0 };
        assert_eq!(r.u8(), SNAPSHOT_BINARY_VERSION);
        let kind = r.u8();
        let tick = r.u64();
        if kind == FRAME_KEYFRAME {
            let players = (0..r.u16()).map(|_| r.player()).collect();
            let creatures = (0..r.u16()).map(|_| r.creature()).collect();
            let hearts = (0..r.u16()).map(|_| r.heart()).collect();
            return Frame::Keyframe((tick, players, creatures, hearts));
        }
        let baseline_tick = r.u64();
        let changed_players = (0..r.u16()).map(|_| r.player()).collect();
        let removed_players = r.ids();
        let changed_creatures = (0..r.u16()).map(|_| r.creature()).collect();
        let removed_creatures = r.ids();
        let changed_hearts = (0..r.u16()).map(|_| r.heart()).collect();
        let removed_hearts = r.ids();
        Frame::Delta(DeltaFrame {
            tick,
            baseline_tick,
            changed_players,
            removed_players,
            changed_creatures,
            removed_creatures,
            changed_hearts,
            removed_hearts,
        })
    }

    fn decode_full(bytes: &[u8]) -> Full {
        let Frame::Keyframe(full) = decode_frame(bytes) else {
            panic!("expected a keyframe");
        };
        full
    }

    fn apply_delta(state: Full, delta: DeltaFrame) -> Full {
        let (tick, mut players, mut creatures, mut hearts) = state;
        assert_eq!(delta.baseline_tick, tick);
        upsert(&mut players, delta.changed_players, |p| p.0);
        drop_ids(&mut players, &delta.removed_players, |p| p.0);
        upsert(&mut creatures, delta.changed_creatures, |c| c.0);
        drop_ids(&mut creatures, &delta.removed_creatures, |c| c.0);
        upsert(&mut hearts, delta.changed_hearts, |h| h.0);
        drop_ids(&mut hearts, &delta.removed_hearts, |h| h.0);
        (delta.tick, players, creatures, hearts)
    }

    fn upsert<T, Id: Fn(&T) -> u32>(into: &mut Vec<T>, changed: Vec<T>, id_of: Id) {
        for item in changed {
            match into
                .iter_mut()
                .find(|existing| id_of(existing) == id_of(&item))
            {
                Some(existing) => *existing = item,
                None => into.push(item),
            }
        }
    }

    fn drop_ids<T, Id: Fn(&T) -> u32>(from: &mut Vec<T>, ids: &[u32], id_of: Id) {
        from.retain(|item| !ids.contains(&id_of(item)));
    }
}

/// Bandwidth-gain benchmark: how many wire bytes/tick each snapshot optimisation saves, for two
/// representative scenarios. Deterministic (no rng), and prints a copy-pasteable table — run with:
///
/// ```text
/// cargo test -p protocol bandwidth_gain -- --nocapture
/// ```
///
/// It measures four encodings of the SAME world and reports each one's reduction vs the JSON-full
/// baseline (the pre-optimization wire):
///   * JSON full          — `serde_json::to_vec(&ServerMsg::Snapshot{..})` of the whole room.
///   * binary keyframe     — `encode_keyframe(..)` of the whole room (phase 1).
///   * binary delta        — `encode_delta(..)` where only ~30% of entities moved (phase 2).
///   * delta + AOI         — the delta of only the entities within `AOI_RADIUS` of one player (phase 3).
#[cfg(test)]
mod bandwidth_gain {
    use super::*;
    use crate::ServerMsg;

    // Mirrors `apps/server/crates/server/src/aoi.rs` (a binary crate the protocol crate cannot depend on);
    // a single player receives only entities within this horizontal radius of them.
    const AOI_RADIUS: f32 = 512.0;
    // Mirrors `sim::WORLD_SIZE` (same reason); the huge-map scenario spreads players uniformly across it.
    const WORLD_SIZE: f32 = 163_840.0;
    // The busy room: the global per-room cap headroom we benchmark + the room creature ceiling (MAX_CREATURES).
    const BUSY_PLAYERS: usize = 10;
    const BUSY_CREATURES: usize = 48;
    // The huge map: a worst-case crowd spread across the whole world, with the same creature ceiling.
    const HUGE_PLAYERS: usize = 1_000;
    const HUGE_CREATURES: usize = 48;
    // A realistic per-tick churn: this fraction of entities moved one step since the baseline.
    const MOVED_FRACTION: usize = 3; // ~1 in 3 (≈30%).
    const STEP: f32 = 0.25;

    struct Snapshot {
        players: Vec<PlayerState>,
        creatures: Vec<CreatureState>,
        hearts: Vec<HeartDropState>,
    }

    /// Lay `players` out evenly across a `span`×`span` square at ground height, plus `creatures` clustered
    /// near the origin (where the chosen receiver stands) and a couple of hearts, so the AOI scenario has
    /// real near/far structure. Deterministic: positions are a function of the index only.
    fn world(players: usize, creatures: usize, span: f32) -> Snapshot {
        let side = (players as f32).sqrt().ceil().max(1.0);
        let players = (0..players)
            .map(|i| {
                let col = i as f32 % side;
                let row = (i as f32 / side).floor();
                let x = (col + 0.5) / side * span;
                let z = (row + 0.5) / side * span;
                PlayerState(i as u32 + 1, x, 64.25, z, 0.31, 0.05, 20, (i * 3) as u32, 3)
            })
            .collect();
        let creatures = (0..creatures)
            .map(|i| {
                let angle = i as f32 * 0.7;
                CreatureState(
                    10_000 + i as u32,
                    (i % 5) as u8,
                    angle.cos() * 20.0,
                    63.5,
                    angle.sin() * 20.0,
                    angle,
                    2,
                    3,
                )
            })
            .collect();
        let hearts = (0..3)
            .map(|i| {
                HeartDropState(
                    20_000 + i as u32,
                    i as f32 * 2.0 - 5.0,
                    63.5,
                    i as f32 * 1.1,
                )
            })
            .collect();
        Snapshot {
            players,
            creatures,
            hearts,
        }
    }

    /// The same world one tick later: ~`1/MOVED_FRACTION` of the players and creatures stepped by `STEP`,
    /// the rest byte-for-byte identical (so the delta carries only the movers).
    fn advance(base: &Snapshot) -> Snapshot {
        let players = base
            .players
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let mut p = p.clone();
                if i % MOVED_FRACTION == 0 {
                    p.1 += STEP;
                    p.3 += STEP;
                }
                p
            })
            .collect();
        let creatures = base
            .creatures
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut c = c.clone();
                if i % MOVED_FRACTION == 0 {
                    c.2 += STEP;
                    c.4 += STEP;
                }
                c
            })
            .collect();
        Snapshot {
            players,
            creatures,
            hearts: base.hearts.clone(),
        }
    }

    fn horizontal_sq(a: (f32, f32), b: (f32, f32)) -> f32 {
        let dx = a.0 - b.0;
        let dz = a.1 - b.1;
        dx * dx + dz * dz
    }

    /// What the player at `center` actually receives: their own record always, plus every other entity
    /// within `AOI_RADIUS`. Mirrors `aoi_view` in room.rs (without hysteresis — a steady-state tick).
    fn aoi_of(snapshot: &Snapshot, receiver_id: u32, center: (f32, f32)) -> Snapshot {
        let within = |x: f32, z: f32| horizontal_sq(center, (x, z)) <= AOI_RADIUS * AOI_RADIUS;
        Snapshot {
            players: snapshot
                .players
                .iter()
                .filter(|p| p.0 == receiver_id || within(p.1, p.3))
                .cloned()
                .collect(),
            creatures: snapshot
                .creatures
                .iter()
                .filter(|c| within(c.2, c.4))
                .cloned()
                .collect(),
            hearts: snapshot
                .hearts
                .iter()
                .filter(|h| within(h.1, h.3))
                .cloned()
                .collect(),
        }
    }

    fn json_full_bytes(s: &Snapshot, tick: u64) -> usize {
        let msg = ServerMsg::Snapshot {
            tick,
            players: s.players.clone(),
            creatures: s.creatures.clone(),
            hearts: s.hearts.clone(),
        };
        serde_json::to_vec(&msg).expect("snapshot serializes").len()
    }

    fn keyframe_bytes(s: &Snapshot, tick: u64) -> usize {
        encode_keyframe(tick, &s.players, &s.creatures, &s.hearts).len()
    }

    fn delta_bytes(baseline: &Snapshot, next: &Snapshot, base_tick: u64, tick: u64) -> usize {
        encode_delta(
            SnapshotView {
                tick: base_tick,
                players: &baseline.players,
                creatures: &baseline.creatures,
                hearts: &baseline.hearts,
            },
            SnapshotView {
                tick,
                players: &next.players,
                creatures: &next.creatures,
                hearts: &next.hearts,
            },
        )
        .len()
    }

    fn reduction_pct(bytes: usize, json_full: usize) -> f32 {
        100.0 * (1.0 - bytes as f32 / json_full as f32)
    }

    /// Print one scenario's table: bytes/tick for each scheme and the % reduction vs JSON-full. `whole`
    /// is the full room (what JSON-full/keyframe/delta carry); `received` is one player's AOI slice.
    fn report(label: &str, whole_base: &Snapshot, received_base: &Snapshot) {
        let whole_next = advance(whole_base);
        let received_next = aoi_of(&whole_next, received_base.players[0].0, {
            let me = &received_base.players[0];
            (me.1, me.3)
        });

        let json_full = json_full_bytes(whole_base, 1);
        let keyframe = keyframe_bytes(whole_base, 1);
        let delta = delta_bytes(whole_base, &whole_next, 1, 2);
        let delta_aoi = delta_bytes(received_base, &received_next, 1, 2);

        println!("\n=== {label} ===");
        println!(
            "  whole room: {} players + {} creatures + {} hearts; one player receives {} players + {} creatures + {} hearts (AOI)",
            whole_base.players.len(),
            whole_base.creatures.len(),
            whole_base.hearts.len(),
            received_base.players.len(),
            received_base.creatures.len(),
            received_base.hearts.len(),
        );
        println!(
            "  {:<28} {:>12} {:>14}",
            "scheme", "bytes/tick", "reduction"
        );
        println!(
            "  {:<28} {:>12} {:>14}",
            "JSON full (baseline)", json_full, "0.0%"
        );
        println!(
            "  {:<28} {:>12} {:>13.1}%",
            "binary keyframe",
            keyframe,
            reduction_pct(keyframe, json_full)
        );
        println!(
            "  {:<28} {:>12} {:>13.1}%",
            "binary delta (~30% moved)",
            delta,
            reduction_pct(delta, json_full)
        );
        println!(
            "  {:<28} {:>12} {:>13.1}%",
            "binary delta + AOI (1 player)",
            delta_aoi,
            reduction_pct(delta_aoi, json_full)
        );
    }

    #[test]
    fn bandwidth_gain_table() {
        // (A) one busy room: every player + creature is in view of everyone (the room is tiny), so the AOI
        // slice is the whole room — AOI gives nothing here, the delta is the win.
        let busy = world(BUSY_PLAYERS, BUSY_CREATURES, 16.0);
        let busy_received = aoi_of(&busy, busy.players[0].0, {
            let me = &busy.players[0];
            (me.1, me.3)
        });
        report(
            "Scenario A — one busy room (10 players + 48 creatures, all in view)",
            &busy,
            &busy_received,
        );

        // (B) a huge map: 1000 players spread uniformly across WORLD_SIZE, so a single player's AOI holds
        // only the handful near them — AOI is the dominant win on top of the delta.
        let huge = world(HUGE_PLAYERS, HUGE_CREATURES, WORLD_SIZE);
        let huge_received = aoi_of(&huge, huge.players[0].0, {
            let me = &huge.players[0];
            (me.1, me.3)
        });
        report(
            "Scenario B — huge map (1000 players across WORLD_SIZE + 48 creatures), one player's view",
            &huge,
            &huge_received,
        );

        // Guard the headline gains so a regression in any phase fails the build (not just the eyeballed table).
        let huge_next = advance(&huge);
        let huge_recv_next = aoi_of(&huge_next, huge.players[0].0, {
            let me = &huge.players[0];
            (me.1, me.3)
        });
        let json_full = json_full_bytes(&huge, 1);
        let delta_aoi = delta_bytes(&huge_received, &huge_recv_next, 1, 2);
        assert!(
            reduction_pct(delta_aoi, json_full) > 99.0,
            "huge-map delta+AOI should cut >99% vs JSON-full; got {:.1}%",
            reduction_pct(delta_aoi, json_full)
        );
    }
}
