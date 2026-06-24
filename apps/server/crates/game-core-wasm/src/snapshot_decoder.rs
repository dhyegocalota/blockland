//! The browser-facing snapshot decoder: a stateful `#[wasm_bindgen]` wrapper over the protocol crate's
//! `SnapshotReconstructor` (the SINGLE Rust decode the server encodes against). The web client feeds every
//! per-tick binary frame — keyframes + baseline-relative deltas — into one of these and gets back the full
//! reconstructed snapshot, replacing the hand-written TS codec/reconstructor that used to mirror the Rust.
//!
//! Marshaling to JS is a single packed `Float64Array` the TS unpacks (see `apps/web/lib/engine/online/
//! wasm-snapshot-decoder.ts`), NOT per-entity JS objects built across the boundary: one contiguous buffer
//! is the cheapest thing to hand wasm→JS, and a frame is a few dozen entities (AOI-bounded), so the unpack
//! loop is trivial.
//!
//! Coord/yaw/pitch fields are packed as their CENTIMETRE INTEGERS (`round(value * 100)`), not the divided
//! float — so the TS unpacker does the final `/100` in JS f64, reproducing the deleted TS codec's
//! `i32 / 100` byte-for-byte. (Dividing inside Rust would keep the value as f32 and widen to a noisy f64
//! like 0.3100000023841858 instead of exactly 0.31 — a real divergence from the old path.) Every other
//! field (ids, counts, kind index, hp) is its exact integer. f64 holds all of these exactly.
//!
//! Packed layout (all f64):
//! ```text
//! [0] tick
//! [1] player count   [2] creature count   [3] heart count
//! players  (9 each): id, x_cm, y_cm, z_cm, yaw_cm, pitch_cm, ping_ms, score, hp
//! creatures(8 each): id, kind_index, x_cm, y_cm, z_cm, yaw_cm, hp, max_hp
//! hearts   (4 each): id, x_cm, y_cm, z_cm
//! ```
//! A delta the reconstructor can't apply yet (stale baseline) marshals to an EMPTY array, which the TS
//! reads as "emit nothing this frame" — the same `null` the old reconstructor returned.

use js_sys::Float64Array;
use protocol::snapshot_codec::{FullSnapshot, SnapshotReconstructor};
use wasm_bindgen::prelude::*;

/// Fields per packed record, mirroring the wire record widths. Kept here as the one place the TS unpacker's
/// strides must agree with.
const PLAYER_FIELDS: usize = 9;
const CREATURE_FIELDS: usize = 8;
const HEART_FIELDS: usize = 4;
/// The fixed header: tick + the three category counts.
const HEADER: usize = 4;
/// The centimetre fixed-point scale coords are packed at (mirrors `snapshot_codec`'s `CM_SCALE`), so the
/// TS unpacker divides by exactly this to land on the same f64 the old `i32 / 100` path produced.
const CM_SCALE: f32 = 100.0;

/// Recover a coord's exact centimetre integer for packing: `FullSnapshot` holds the decoded f32 (`cm / 100`
/// as f32); `* 100` rounded lands back on the original integer the wire carried, which f64 holds exactly.
fn cm(value: f32) -> f64 {
    (value * CM_SCALE).round() as f64
}

/// A stateful decoder for one connection's snapshot stream. Holds the running baseline (via the protocol
/// reconstructor) so deltas reconstruct against the last full frame. STANDALONE — no Room/WasmCore needed;
/// both the online socket path and the offline core-drain build one and feed it bytes.
#[wasm_bindgen]
pub struct SnapshotDecoder {
    reconstructor: SnapshotReconstructor,
}

#[wasm_bindgen]
impl SnapshotDecoder {
    /// A fresh decoder with no baseline yet — the first frame must be a keyframe (a delta before any
    /// keyframe yields the empty "emit nothing" buffer, exactly like the old TS reconstructor).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> SnapshotDecoder {
        SnapshotDecoder {
            reconstructor: SnapshotReconstructor::new(),
        }
    }

    /// Decode one binary frame and return the full reconstructed snapshot packed into a `Float64Array`
    /// (layout above), updating the held baseline. Returns an EMPTY array for a delta that can't be applied
    /// yet (stale baseline / no keyframe). Throws on a corrupt or stale-version frame.
    #[wasm_bindgen]
    pub fn decode(&mut self, bytes: &[u8]) -> Result<Float64Array, JsValue> {
        let snapshot = self
            .reconstructor
            .apply(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        match snapshot {
            Some(full) => Ok(pack(&full)),
            None => Ok(Float64Array::new_with_length(0)),
        }
    }
}

/// Pack a full snapshot into the flat f64 buffer the TS unpacks. One allocation sized exactly to the frame.
fn pack(full: &FullSnapshot) -> Float64Array {
    let len = HEADER
        + full.players.len() * PLAYER_FIELDS
        + full.creatures.len() * CREATURE_FIELDS
        + full.hearts.len() * HEART_FIELDS;
    let mut out = Vec::with_capacity(len);
    out.push(full.tick as f64);
    out.push(full.players.len() as f64);
    out.push(full.creatures.len() as f64);
    out.push(full.hearts.len() as f64);
    for p in &full.players {
        out.extend_from_slice(&[
            p.0 as f64,
            cm(p.1),
            cm(p.2),
            cm(p.3),
            cm(p.4),
            cm(p.5),
            p.6 as f64,
            p.7 as f64,
            p.8 as f64,
        ]);
    }
    for c in &full.creatures {
        out.extend_from_slice(&[
            c.0 as f64,
            c.1 as f64,
            cm(c.2),
            cm(c.3),
            cm(c.4),
            cm(c.5),
            c.6 as f64,
            c.7 as f64,
        ]);
    }
    for h in &full.hearts {
        out.extend_from_slice(&[h.0 as f64, cm(h.1), cm(h.2), cm(h.3)]);
    }
    Float64Array::from(out.as_slice())
}
