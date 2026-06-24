// Minimal binary snapshot decoder for the load harness — a JS mirror of
// `apps/server/crates/protocol/src/snapshot_codec.rs` and `apps/web/lib/snapshot-codec.ts`.
// The bots need it to know which creatures/players are near them (to Hit / AttackPlayer), so each bot
// keeps a running full snapshot and applies keyframes/deltas onto it exactly like the web client's
// SnapshotReconstructor.

const SNAPSHOT_BINARY_VERSION = 1;
const FRAME_KEYFRAME = 0;
const FRAME_DELTA = 1;
const CM_SCALE = 100;

class Reader {
  constructor(buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = 0;
  }

  u8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64() {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(value);
  }

  cm() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value / CM_SCALE;
  }

  player() {
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

  creature() {
    return {
      id: this.u32(),
      kind: this.u8(),
      x: this.cm(),
      y: this.cm(),
      z: this.cm(),
      yaw: this.cm(),
      hp: this.u8(),
      max_hp: this.u8(),
    };
  }

  heart() {
    return { id: this.u32(), x: this.cm(), y: this.cm(), z: this.cm() };
  }

  list(read) {
    const count = this.u16();
    const items = [];
    for (let i = 0; i < count; i += 1) items.push(read());
    return items;
  }

  ids() {
    const count = this.u16();
    const ids = [];
    for (let i = 0; i < count; i += 1) ids.push(this.u32());
    return ids;
  }
}

// Decode one binary frame into a typed keyframe or delta. Throws on a version/kind it does not know, so a
// protocol drift surfaces loudly rather than corrupting a bot's known-entities set.
export function decodeFrame(buffer) {
  const reader = new Reader(buffer);
  const version = reader.u8();
  if (version !== SNAPSHOT_BINARY_VERSION) {
    throw new Error(`unsupported snapshot binary version ${version}`);
  }
  const kind = reader.u8();
  const tick = reader.u64();
  if (kind === FRAME_KEYFRAME) {
    return {
      kind: FRAME_KEYFRAME,
      tick,
      players: reader.list(() => reader.player()),
      creatures: reader.list(() => reader.creature()),
      hearts: reader.list(() => reader.heart()),
    };
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

// A bot's running full snapshot, rebuilt from a keyframe then maintained by applying deltas onto it —
// the same upsert/remove the client's reconstructor does. `players`/`creatures`/`hearts` are id-keyed Maps.
export class SnapshotState {
  constructor() {
    this.tick = -1;
    this.players = new Map();
    this.creatures = new Map();
    this.hearts = new Map();
  }

  apply(frame) {
    if (frame.kind === FRAME_KEYFRAME) {
      this.tick = frame.tick;
      this.players = new Map(frame.players.map((p) => [p.id, p]));
      this.creatures = new Map(frame.creatures.map((c) => [c.id, c]));
      this.hearts = new Map(frame.hearts.map((h) => [h.id, h]));
      return;
    }
    // A delta whose baseline isn't the state we hold can't be applied — drop it and wait for the next
    // keyframe (the server sends one every KEYFRAME_INTERVAL_TICKS), exactly as the client would.
    if (frame.baselineTick !== this.tick) return;
    upsert(this.players, frame.changedPlayers);
    remove(this.players, frame.removedPlayers);
    upsert(this.creatures, frame.changedCreatures);
    remove(this.creatures, frame.removedCreatures);
    upsert(this.hearts, frame.changedHearts);
    remove(this.hearts, frame.removedHearts);
    this.tick = frame.tick;
  }
}

function upsert(map, changed) {
  for (const item of changed) map.set(item.id, item);
}

function remove(map, ids) {
  for (const id of ids) map.delete(id);
}

// Nearest entity (by horizontal distance from `(x, z)`) within `reach`, excluding `selfId`. Returns the
// entity or null. Used to pick a creature to Hit or a player to AttackPlayer.
export function nearestWithin(map, x, z, reach, selfId) {
  let best = null;
  let bestSq = reach * reach;
  for (const entity of map.values()) {
    if (entity.id === selfId) continue;
    const dx = entity.x - x;
    const dz = entity.z - z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= bestSq) {
      bestSq = distSq;
      best = entity;
    }
  }
  return best;
}
