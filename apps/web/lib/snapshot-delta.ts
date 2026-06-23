// Stateful reconstruction of the full per-tick snapshot from the server's keyframe + delta stream. The
// transport keeps the authoritative full entity state here; on each binary frame it applies the change
// and hands `net.ts` the SAME full `{ t:'snapshot', tick, players, creatures, hearts }` object the JSON
// path produced — nothing downstream of `onSnapshot` changes. Pure (no three.js, no DOM): unit-tested in
// `snapshot-delta.test.ts`. The wire decode lives in `snapshot-codec.ts`; this module owns the apply rules.

import { decodeFrame, FRAME_KEYFRAME, type SnapshotDelta } from './snapshot-codec';
import type { SnapshotCreature, SnapshotHeart, SnapshotMsg, SnapshotPlayer } from './net-snapshot';

// Holds the running full snapshot. A KEYFRAME replaces it; a DELTA whose baseline matches the current
// tick mutates it in place. A DELTA against a stale baseline (a missed frame — shouldn't happen on an
// ordered socket, but be safe) is dropped, leaving the state untouched until the next keyframe.
export class SnapshotReconstructor {
  private current: SnapshotMsg | null = null;

  // Apply one binary frame; returns the reconstructed full snapshot to emit, or null to emit nothing
  // (a delta we can't safely apply yet — wait for the next keyframe).
  apply(bytes: ArrayBuffer): SnapshotMsg | null {
    const frame = decodeFrame(bytes);
    if (frame.kind === FRAME_KEYFRAME) {
      this.current = frame.snapshot;
      return frame.snapshot;
    }
    return this.applyDelta(frame);
  }

  private applyDelta(delta: SnapshotDelta): SnapshotMsg | null {
    if (this.current === null) return null;
    if (delta.baselineTick !== this.current.tick) return null;
    const next: SnapshotMsg = {
      t: 'snapshot',
      tick: delta.tick,
      players: applyChanges(this.current.players, delta.changedPlayers, delta.removedPlayers),
      creatures: applyChanges(this.current.creatures, delta.changedCreatures, delta.removedCreatures),
      hearts: applyChanges(this.current.hearts, delta.changedHearts, delta.removedHearts),
    };
    this.current = next;
    return next;
  }
}

type Entity = SnapshotPlayer | SnapshotCreature | SnapshotHeart;

// Upsert the changed/added records and drop the removed ids, keeping every other entity as-is.
function applyChanges<T extends Entity>(base: T[], changed: T[], removed: number[]): T[] {
  const byId = new Map<number, T>();
  for (const item of base) byId.set(item.id, item);
  for (const id of removed) byId.delete(id);
  for (const item of changed) byId.set(item.id, item);
  return [...byId.values()];
}
