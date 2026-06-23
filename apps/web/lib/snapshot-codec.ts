// Binary codec for the hot per-tick snapshot frames. The Rust counterpart that encodes them lives in
// `apps/server/crates/protocol/src/snapshot_codec.rs`; the two are kept in lock-step by shared hex
// fixtures (see `snapshot-codec.test.ts`). Only the snapshot goes binary — every other message is JSON.
// This module is pure (no three.js, no DOM): it decodes the bytes into a typed frame (a full KEYFRAME or
// a baseline-relative DELTA). `snapshot-delta.ts` keeps the running full state and applies frames onto it.
//
// Byte layout (little-endian), mirroring the Rust doc comment:
//   [0]      u8   version tag (SNAPSHOT_BINARY_VERSION)
//   [1]      u8   frame kind (FRAME_KEYFRAME | FRAME_DELTA)
//   [2..10]  u64  tick
// A KEYFRAME then carries the full snapshot:
//   u16 player count, then per player:
//     u32 id, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, i32 pitch_cm, u32 ping_ms, u32 score, u8 hp
//   u16 creature count, then per creature:
//     u32 id, u8 kind_index, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, u8 hp, u8 max_hp
//   u16 heart count, then per heart:
//     u32 id, i32 x_cm, i32 y_cm, i32 z_cm
// A DELTA then carries: u64 baseline_tick, then per category the changed/added records followed by the
// removed ids: u16 changed count + records, u16 removed count + u32 ids (players, creatures, hearts).
// Floats arrive as i32 centimetres (value*100, rounded server-side); we divide by 100 to restore them
// to exactly the centimetre-rounded numbers the JSON path produced.

import type { SnapshotCreature, SnapshotHeart, SnapshotMsg, SnapshotPlayer } from './net-snapshot';
import { CREATURE_KINDS } from './net-snapshot';

export const SNAPSHOT_BINARY_VERSION = 1;
export const FRAME_KEYFRAME = 0;
export const FRAME_DELTA = 1;
const CM_SCALE = 100;

// A decoded delta: per category, the changed/added full records and the ids removed since the baseline.
// An entity not mentioned here is unchanged. `tick` is this frame's tick; `baselineTick` is the state it
// must be applied onto.
export interface SnapshotDelta {
  kind: typeof FRAME_DELTA;
  tick: number;
  baselineTick: number;
  changedPlayers: SnapshotPlayer[];
  removedPlayers: number[];
  changedCreatures: SnapshotCreature[];
  removedCreatures: number[];
  changedHearts: SnapshotHeart[];
  removedHearts: number[];
}

export interface SnapshotKeyframe {
  kind: typeof FRAME_KEYFRAME;
  snapshot: SnapshotMsg;
}

export type SnapshotFrame = SnapshotKeyframe | SnapshotDelta;

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(bytes: ArrayBuffer) {
    this.view = new DataView(bytes);
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): number {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(value);
  }

  cm(): number {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value / CM_SCALE;
  }

  player(): SnapshotPlayer {
    return {
      id: this.u32(),
      x: this.cm(),
      y: this.cm(),
      z: this.cm(),
      yaw: this.cm(),
      pitch: this.cm(),
      ping_ms: this.u32(),
      score: this.u32(),
      hp: this.u8(),
    };
  }

  creature(): SnapshotCreature {
    const id = this.u32();
    const kindIndex = this.u8();
    const kind = CREATURE_KINDS[kindIndex];
    if (!kind) throw new Error(`unknown creature kind index ${kindIndex}`);
    return {
      id,
      kind,
      x: this.cm(),
      y: this.cm(),
      z: this.cm(),
      yaw: this.cm(),
      hp: this.u8(),
      max_hp: this.u8(),
    };
  }

  heart(): SnapshotHeart {
    return { id: this.u32(), x: this.cm(), y: this.cm(), z: this.cm() };
  }

  list<T>(read: () => T): T[] {
    const count = this.u16();
    const items: T[] = [];
    for (let i = 0; i < count; i += 1) items.push(read());
    return items;
  }

  ids(): number[] {
    const count = this.u16();
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) ids.push(this.u32());
    return ids;
  }
}

class GrowableWriter {
  private bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  u32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    this.push(view);
  }

  u64(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(value), true);
    this.push(view);
  }

  cm(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, Math.round(value * CM_SCALE), true);
    this.push(view);
  }

  player(p: SnapshotPlayer): void {
    this.u32(p.id);
    this.cm(p.x);
    this.cm(p.y);
    this.cm(p.z);
    this.cm(p.yaw);
    this.cm(p.pitch);
    this.u32(p.ping_ms);
    this.u32(p.score);
    this.u8(p.hp);
  }

  creature(c: SnapshotCreature): void {
    const kindIndex = CREATURE_KINDS.indexOf(c.kind as (typeof CREATURE_KINDS)[number]);
    if (kindIndex < 0) throw new Error(`unknown creature kind ${c.kind}`);
    this.u32(c.id);
    this.u8(kindIndex);
    this.cm(c.x);
    this.cm(c.y);
    this.cm(c.z);
    this.cm(c.yaw);
    this.u8(c.hp);
    this.u8(c.max_hp);
  }

  heart(h: SnapshotHeart): void {
    this.u32(h.id);
    this.cm(h.x);
    this.cm(h.y);
    this.cm(h.z);
  }

  private push(view: DataView): void {
    for (let i = 0; i < view.byteLength; i += 1) this.bytes.push(view.getUint8(i));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// Encode a full snapshot as a keyframe (the same binary wire form the Rust server emits). The server is
// the real producer in production; this exists so tests (and any future client-side use) can build
// identical frames without re-stating the byte layout.
export function encodeKeyframe(snapshot: SnapshotMsg): Uint8Array {
  const writer = new GrowableWriter();
  writer.u8(SNAPSHOT_BINARY_VERSION);
  writer.u8(FRAME_KEYFRAME);
  writer.u64(snapshot.tick);

  writer.u16(snapshot.players.length);
  for (const p of snapshot.players) writer.player(p);
  writer.u16(snapshot.creatures.length);
  for (const c of snapshot.creatures) writer.creature(c);
  writer.u16(snapshot.hearts.length);
  for (const h of snapshot.hearts) writer.heart(h);
  return writer.finish();
}

// Encode the delta of `next` against `baseline` (same wire form the Rust server emits): the changed/added
// entities as full records plus the ids removed since the baseline, per category. The server is the real
// producer in production; this exists so tests can build identical frames without re-stating the layout.
export function encodeDelta(baseline: SnapshotMsg, next: SnapshotMsg): Uint8Array {
  const writer = new GrowableWriter();
  writer.u8(SNAPSHOT_BINARY_VERSION);
  writer.u8(FRAME_DELTA);
  writer.u64(next.tick);
  writer.u64(baseline.tick);

  const changedPlayers = changedEntities(next.players, baseline.players, playerEqual);
  writer.u16(changedPlayers.length);
  for (const p of changedPlayers) writer.player(p);
  writeIds(writer, removedIds(baseline.players, next.players));

  const changedCreatures = changedEntities(next.creatures, baseline.creatures, creatureEqual);
  writer.u16(changedCreatures.length);
  for (const c of changedCreatures) writer.creature(c);
  writeIds(writer, removedIds(baseline.creatures, next.creatures));

  const changedHearts = changedEntities(next.hearts, baseline.hearts, heartEqual);
  writer.u16(changedHearts.length);
  for (const h of changedHearts) writer.heart(h);
  writeIds(writer, removedIds(baseline.hearts, next.hearts));

  return writer.finish();
}

function writeIds(writer: GrowableWriter, ids: number[]): void {
  writer.u16(ids.length);
  for (const id of ids) writer.u32(id);
}

function changedEntities<T extends { id: number }>(
  next: T[],
  baseline: T[],
  equal: (a: T, b: T) => boolean,
): T[] {
  return next.filter((item) => {
    const prev = baseline.find((b) => b.id === item.id);
    if (!prev) return true;
    return !equal(prev, item);
  });
}

function removedIds<T extends { id: number }>(baseline: T[], next: T[]): number[] {
  return baseline.filter((b) => !next.some((n) => n.id === b.id)).map((b) => b.id);
}

// Compare floats at wire precision (centimetres) so a sub-centimetre wobble the wire would round to the
// same bytes is NOT counted as a change — otherwise the delta would resend unchanged entities.
function cmEqual(a: number, b: number): boolean {
  return Math.round(a * CM_SCALE) === Math.round(b * CM_SCALE);
}

function playerEqual(a: SnapshotPlayer, b: SnapshotPlayer): boolean {
  return (
    cmEqual(a.x, b.x) &&
    cmEqual(a.y, b.y) &&
    cmEqual(a.z, b.z) &&
    cmEqual(a.yaw, b.yaw) &&
    cmEqual(a.pitch, b.pitch) &&
    a.ping_ms === b.ping_ms &&
    a.score === b.score &&
    a.hp === b.hp
  );
}

function creatureEqual(a: SnapshotCreature, b: SnapshotCreature): boolean {
  return (
    a.kind === b.kind &&
    cmEqual(a.x, b.x) &&
    cmEqual(a.y, b.y) &&
    cmEqual(a.z, b.z) &&
    cmEqual(a.yaw, b.yaw) &&
    a.hp === b.hp &&
    a.max_hp === b.max_hp
  );
}

function heartEqual(a: SnapshotHeart, b: SnapshotHeart): boolean {
  return cmEqual(a.x, b.x) && cmEqual(a.y, b.y) && cmEqual(a.z, b.z);
}

// Decode a binary frame into a typed keyframe or delta. The version byte is checked so a stale decoder
// rejects rather than misreads.
export function decodeFrame(bytes: ArrayBuffer): SnapshotFrame {
  const reader = new Reader(bytes);
  const version = reader.u8();
  if (version !== SNAPSHOT_BINARY_VERSION) {
    throw new Error(`unsupported snapshot binary version ${version}`);
  }
  const kind = reader.u8();
  const tick = reader.u64();
  if (kind === FRAME_KEYFRAME) {
    const players = reader.list(() => reader.player());
    const creatures = reader.list(() => reader.creature());
    const hearts = reader.list(() => reader.heart());
    return { kind: FRAME_KEYFRAME, snapshot: { t: 'snapshot', tick, players, creatures, hearts } };
  }
  if (kind !== FRAME_DELTA) throw new Error(`unknown snapshot frame kind ${kind}`);
  const baselineTick = reader.u64();
  return {
    kind: FRAME_DELTA,
    tick,
    baselineTick,
    changedPlayers: reader.list(() => reader.player()),
    removedPlayers: reader.ids(),
    changedCreatures: reader.list(() => reader.creature()),
    removedCreatures: reader.ids(),
    changedHearts: reader.list(() => reader.heart()),
    removedHearts: reader.ids(),
  };
}
