// Binary decoder for the hot per-tick snapshot frame. The Rust counterpart that encodes it lives in
// `apps/server/crates/protocol/src/snapshot_codec.rs`; the two are kept in lock-step by a shared hex
// fixture (see `snapshot-codec.test.ts`). Only the snapshot goes binary — every other message is JSON.
// This module is pure (no three.js, no DOM) so it unit-tests trivially and stays at the net boundary.
//
// Byte layout (little-endian), mirroring the Rust doc comment:
//   [0]      u8   version tag (SNAPSHOT_BINARY_VERSION)
//   [1..9]   u64  tick
//   u16 player count, then per player:
//     u32 id, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, i32 pitch_cm, u32 ping_ms, u32 score, u8 hp
//   u16 creature count, then per creature:
//     u32 id, u8 kind_index, i32 x_cm, i32 y_cm, i32 z_cm, i32 yaw_cm, u8 hp, u8 max_hp
//   u16 heart count, then per heart:
//     u32 id, i32 x_cm, i32 y_cm, i32 z_cm
// Floats arrive as i32 centimetres (value*100, rounded server-side); we divide by 100 to restore them
// to exactly the centimetre-rounded numbers the JSON path produced.

import type { SnapshotCreature, SnapshotHeart, SnapshotMsg, SnapshotPlayer } from './net-snapshot';
import { CREATURE_KINDS } from './net-snapshot';

export const SNAPSHOT_BINARY_VERSION = 1;
const CM_SCALE = 100;

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

  private push(view: DataView): void {
    for (let i = 0; i < view.byteLength; i += 1) this.bytes.push(view.getUint8(i));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// Encode a snapshot to the same binary wire form the Rust server emits. The server is the real producer
// in production; this exists so tests (and any future client-side use) can build identical frames without
// re-stating the byte layout. The kind table is reversed back to its `kind_index` for the wire.
export function encodeSnapshot(snapshot: SnapshotMsg): Uint8Array {
  const writer = new GrowableWriter();
  writer.u8(SNAPSHOT_BINARY_VERSION);
  writer.u64(snapshot.tick);

  writer.u16(snapshot.players.length);
  for (const p of snapshot.players) {
    writer.u32(p.id);
    writer.cm(p.x);
    writer.cm(p.y);
    writer.cm(p.z);
    writer.cm(p.yaw);
    writer.cm(p.pitch);
    writer.u32(p.ping_ms);
    writer.u32(p.score);
    writer.u8(p.hp);
  }

  writer.u16(snapshot.creatures.length);
  for (const c of snapshot.creatures) {
    const kindIndex = CREATURE_KINDS.indexOf(c.kind as (typeof CREATURE_KINDS)[number]);
    if (kindIndex < 0) throw new Error(`unknown creature kind ${c.kind}`);
    writer.u32(c.id);
    writer.u8(kindIndex);
    writer.cm(c.x);
    writer.cm(c.y);
    writer.cm(c.z);
    writer.cm(c.yaw);
    writer.u8(c.hp);
    writer.u8(c.max_hp);
  }

  writer.u16(snapshot.hearts.length);
  for (const h of snapshot.hearts) {
    writer.u32(h.id);
    writer.cm(h.x);
    writer.cm(h.y);
    writer.cm(h.z);
  }

  return writer.finish();
}

export function decodeSnapshot(bytes: ArrayBuffer): SnapshotMsg {
  const reader = new Reader(bytes);
  const version = reader.u8();
  if (version !== SNAPSHOT_BINARY_VERSION) {
    throw new Error(`unsupported snapshot binary version ${version}`);
  }
  const tick = reader.u64();

  const playerCount = reader.u16();
  const players: SnapshotPlayer[] = [];
  for (let i = 0; i < playerCount; i += 1) {
    players.push({
      id: reader.u32(),
      x: reader.cm(),
      y: reader.cm(),
      z: reader.cm(),
      yaw: reader.cm(),
      pitch: reader.cm(),
      ping_ms: reader.u32(),
      score: reader.u32(),
      hp: reader.u8(),
    });
  }

  const creatureCount = reader.u16();
  const creatures: SnapshotCreature[] = [];
  for (let i = 0; i < creatureCount; i += 1) {
    const id = reader.u32();
    const kindIndex = reader.u8();
    const kind = CREATURE_KINDS[kindIndex];
    if (!kind) throw new Error(`unknown creature kind index ${kindIndex}`);
    creatures.push({
      id,
      kind,
      x: reader.cm(),
      y: reader.cm(),
      z: reader.cm(),
      yaw: reader.cm(),
      hp: reader.u8(),
      max_hp: reader.u8(),
    });
  }

  const heartCount = reader.u16();
  const hearts: SnapshotHeart[] = [];
  for (let i = 0; i < heartCount; i += 1) {
    hearts.push({ id: reader.u32(), x: reader.cm(), y: reader.cm(), z: reader.cm() });
  }

  return { t: 'snapshot', tick, players, creatures, hearts };
}
