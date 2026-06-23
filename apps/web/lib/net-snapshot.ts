// Shared snapshot shapes + the creature kind table, used by both the net client (`net.ts`) and the
// binary decoder (`snapshot-codec.ts`). The decoded shape is the named form the rest of the client
// consumes; only these two modules know the wire index order and the kind table. The kind table mirrors
// the Rust `CreatureKind::ALL` (the `index()` the server emits as `kind_index`).

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
