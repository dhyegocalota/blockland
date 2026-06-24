// Unpacks the wasm `SnapshotDecoder`'s packed `Float64Array` frame into the named `SnapshotMsg` the
// renderer/coop consume. The binary decode + keyframe/delta reconstruction now lives in Rust (the protocol
// crate's `SnapshotReconstructor`, wrapped by the wasm `SnapshotDecoder`) — the single source of truth the
// server encodes against. This module is the thin TS seam: hand it a decoder + bytes, get back the same
// full `{ t:'snapshot', tick, players, creatures, hearts }` object the deleted TS codec produced, or null
// for a delta with no usable baseline (the empty buffer the wasm returns). Pure: unit-tested with a fake
// decoder + the cross-language hex fixtures.
//
// Packed layout (all f64), mirroring `crates/game-core-wasm/src/snapshot_decoder.rs`. Coord/yaw/pitch
// fields arrive as their CENTIMETRE INTEGERS; we divide them by CM_SCALE here in JS f64, reproducing the
// deleted TS codec's `i32 / 100` byte-for-byte (the wasm deliberately doesn't pre-divide — doing it in
// Rust f32 then widening would yield a noisy double like 0.3100000023841858 instead of exactly 0.31).
//   [0] tick  [1] player count  [2] creature count  [3] heart count
//   players  (9 each): id, x_cm, y_cm, z_cm, yaw_cm, pitch_cm, ping_ms, score, hp
//   creatures(8 each): id, kind_index, x_cm, y_cm, z_cm, yaw_cm, hp, max_hp
//   hearts   (4 each): id, x_cm, y_cm, z_cm

import type { WasmSnapshotDecoder } from './wasm-core-loader';
import { CREATURE_KINDS, type SnapshotMsg } from '../../net-snapshot';

const HEADER = 4;
const PLAYER_FIELDS = 9;
const CREATURE_FIELDS = 8;
const HEART_FIELDS = 4;
// Matches the Rust packer's CM_SCALE; coord fields are centimetre integers we divide back in JS f64.
const CM_SCALE = 100;

// Decode one binary frame through the wasm decoder and unpack it into the named snapshot, or null when the
// decoder emitted nothing (a delta it can't apply yet — wait for the next keyframe).
export function decodeSnapshot(decoder: WasmSnapshotDecoder, bytes: Uint8Array): SnapshotMsg | null {
  const packed = decoder.decode(bytes);
  if (packed.length === 0) return null;
  return unpack(packed);
}

function unpack(packed: Float64Array): SnapshotMsg {
  const tick = packed[0];
  const playerCount = packed[1];
  const creatureCount = packed[2];
  const heartCount = packed[3];

  let offset = HEADER;
  const players = [];
  for (let i = 0; i < playerCount; i += 1) {
    players.push({
      id: packed[offset],
      x: packed[offset + 1] / CM_SCALE,
      y: packed[offset + 2] / CM_SCALE,
      z: packed[offset + 3] / CM_SCALE,
      yaw: packed[offset + 4] / CM_SCALE,
      pitch: packed[offset + 5] / CM_SCALE,
      ping_ms: packed[offset + 6],
      score: packed[offset + 7],
      hp: packed[offset + 8],
    });
    offset += PLAYER_FIELDS;
  }

  const creatures = [];
  for (let i = 0; i < creatureCount; i += 1) {
    const kindIndex = packed[offset + 1];
    const kind = CREATURE_KINDS[kindIndex];
    if (!kind) throw new Error(`unknown creature kind index ${kindIndex}`);
    creatures.push({
      id: packed[offset],
      kind,
      x: packed[offset + 2] / CM_SCALE,
      y: packed[offset + 3] / CM_SCALE,
      z: packed[offset + 4] / CM_SCALE,
      yaw: packed[offset + 5] / CM_SCALE,
      hp: packed[offset + 6],
      max_hp: packed[offset + 7],
    });
    offset += CREATURE_FIELDS;
  }

  const hearts = [];
  for (let i = 0; i < heartCount; i += 1) {
    hearts.push({
      id: packed[offset],
      x: packed[offset + 1] / CM_SCALE,
      y: packed[offset + 2] / CM_SCALE,
      z: packed[offset + 3] / CM_SCALE,
    });
    offset += HEART_FIELDS;
  }

  return { t: 'snapshot', tick, players, creatures, hearts };
}
