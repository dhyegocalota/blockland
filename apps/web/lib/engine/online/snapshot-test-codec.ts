// TEST-ONLY binary snapshot encoder: synthesizes the wire frames the Rust server (or the offline core)
// emits, so unit tests can feed a fake socket/core real keyframe+delta bytes and exercise the wasm decoder
// end-to-end. Production NEVER encodes on the client (it only decodes — the server is authoritative); this
// lives under a `.ts` used solely by `*.test.ts`. The byte layout mirrors `protocol::snapshot_codec`
// (asserted byte-for-byte by the cross-language hex fixtures), so frames it builds decode identically.

import { CREATURE_KINDS, type SnapshotCreature, type SnapshotHeart, type SnapshotMsg, type SnapshotPlayer } from '../../net-snapshot';

const SNAPSHOT_BINARY_VERSION = 1;
const FRAME_KEYFRAME = 0;
const FRAME_DELTA = 1;
const CM_SCALE = 100;

class Writer {
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

// Encode a full snapshot as a keyframe — the frame a just-joined connection receives.
export function encodeKeyframe(snapshot: SnapshotMsg): Uint8Array {
  const writer = new Writer();
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

// Encode the delta of `next` against `baseline`: the changed/added entities as full records plus the ids
// removed since the baseline, per category.
export function encodeDelta(baseline: SnapshotMsg, next: SnapshotMsg): Uint8Array {
  const writer = new Writer();
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

function writeIds(writer: Writer, ids: number[]): void {
  writer.u16(ids.length);
  for (const id of ids) writer.u32(id);
}

function changedEntities<T extends { id: number }>(next: T[], baseline: T[], equal: (a: T, b: T) => boolean): T[] {
  return next.filter((item) => {
    const prev = baseline.find((b) => b.id === item.id);
    if (!prev) return true;
    return !equal(prev, item);
  });
}

function removedIds<T extends { id: number }>(baseline: T[], next: T[]): number[] {
  return baseline.filter((b) => !next.some((n) => n.id === b.id)).map((b) => b.id);
}

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
