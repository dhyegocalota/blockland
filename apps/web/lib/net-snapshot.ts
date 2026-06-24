// Shared snapshot shapes + the creature kind table. The binary decode now lives in Rust (the wasm
// `SnapshotDecoder` over `protocol::snapshot_codec`); the `wasm-snapshot-decoder.ts` adapter unpacks its
// packed frame into these named shapes, which the rest of the client (`net.ts`, coop, renderer) consumes.
// The kind table mirrors the Rust `CreatureKind::ALL` (the `index()` the server emits as `kind_index`),
// so the adapter maps `kind_index` back to a slug.

export const CREATURE_KINDS = ['pig', 'chicken', 'cow', 'slime', 'spider'] as const;

export interface SnapshotPlayer {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  ping_ms: number;
  score: number;
  hp: number;
}

export interface SnapshotCreature {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  max_hp: number;
}

export interface SnapshotHeart {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface SnapshotMsg {
  t: 'snapshot';
  tick: number;
  players: SnapshotPlayer[];
  creatures: SnapshotCreature[];
  hearts: SnapshotHeart[];
}
