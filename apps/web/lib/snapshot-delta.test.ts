import { describe, expect, it } from 'vitest';
import { encodeKeyframe, encodeDelta } from './snapshot-codec';
import { SnapshotReconstructor } from './snapshot-delta';
import type { SnapshotMsg } from './net-snapshot';

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const keyframe = (snapshot: SnapshotMsg) => toBuffer(encodeKeyframe(snapshot));
const delta = (baseline: SnapshotMsg, next: SnapshotMsg) => toBuffer(encodeDelta(baseline, next));

describe('snapshot reconstructor', () => {
  it('a keyframe sets the full state and is emitted as-is', () => {
    const r = new SnapshotReconstructor();
    const snapshot: SnapshotMsg = {
      t: 'snapshot',
      tick: 3,
      players: [{ id: 1, x: 1, y: 2, z: 3, yaw: 0.1, pitch: 0.2, ping_ms: 5, score: 1, hp: 3 }],
      creatures: [{ id: 9, kind: 'cow', x: 4, y: 5, z: 6, yaw: 0.3, hp: 2, max_hp: 4 }],
      hearts: [{ id: 7, x: 7, y: 8, z: 9 }],
    };
    expect(r.apply(keyframe(snapshot))).toEqual(snapshot);
  });

  it('a delta upserts changed, drops removed, and keeps the rest', () => {
    const r = new SnapshotReconstructor();
    const base: SnapshotMsg = {
      t: 'snapshot',
      tick: 1,
      players: [
        { id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
        { id: 2, x: 5, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
      ],
      creatures: [{ id: 9, kind: 'pig', x: 1, y: 1, z: 1, yaw: 0, hp: 2, max_hp: 2 }],
      hearts: [{ id: 7, x: 0, y: 0, z: 0 }],
    };
    // Player 1 moves, player 2 leaves, player 3 joins; the creature is unchanged; the heart leaves.
    const next: SnapshotMsg = {
      t: 'snapshot',
      tick: 2,
      players: [
        { id: 1, x: 9, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
        { id: 3, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
      ],
      creatures: base.creatures,
      hearts: [],
    };
    r.apply(keyframe(base));
    const reconstructed = r.apply(delta(base, next));
    expect(reconstructed).toEqual(next);
  });

  it('moving one entity while another stays still reconstructs both', () => {
    const r = new SnapshotReconstructor();
    const base: SnapshotMsg = {
      t: 'snapshot',
      tick: 10,
      players: [
        { id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
        { id: 2, x: 5, y: 5, z: 5, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
      ],
      creatures: [],
      hearts: [],
    };
    const next: SnapshotMsg = {
      t: 'snapshot',
      tick: 11,
      players: [
        { id: 1, x: 1, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
        base.players[1], // unchanged
      ],
      creatures: [],
      hearts: [],
    };
    r.apply(keyframe(base));
    const reconstructed = r.apply(delta(base, next));
    expect(reconstructed?.players.find((p) => p.id === 1)?.x).toBe(1);
    expect(reconstructed?.players.find((p) => p.id === 2)).toEqual(base.players[1]);
  });

  it('drops a delta whose baseline does not match the current tick, leaving state unchanged', () => {
    const r = new SnapshotReconstructor();
    const base: SnapshotMsg = {
      t: 'snapshot',
      tick: 5,
      players: [{ id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
      creatures: [],
      hearts: [],
    };
    r.apply(keyframe(base));
    // A delta built on tick 9 (never seen) — must be dropped, emitting nothing.
    const staleBaseline: SnapshotMsg = { ...base, tick: 9 };
    const next: SnapshotMsg = {
      t: 'snapshot',
      tick: 10,
      players: [{ id: 1, x: 9, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
      creatures: [],
      hearts: [],
    };
    expect(r.apply(delta(staleBaseline, next))).toBeNull();

    // The state was untouched, so the next valid delta (against tick 5) still applies.
    const valid: SnapshotMsg = { ...next, tick: 6 };
    const reconstructed = r.apply(delta(base, valid));
    expect(reconstructed).toEqual(valid);
  });

  it('a delta arriving before any keyframe is dropped', () => {
    const r = new SnapshotReconstructor();
    const base: SnapshotMsg = { t: 'snapshot', tick: 1, players: [], creatures: [], hearts: [] };
    const next: SnapshotMsg = { t: 'snapshot', tick: 2, players: [], creatures: [], hearts: [] };
    expect(r.apply(delta(base, next))).toBeNull();
  });

  it('reconstructs an exact sequence: keyframe then a chain of deltas', () => {
    const r = new SnapshotReconstructor();
    const frames: SnapshotMsg[] = [
      {
        t: 'snapshot',
        tick: 1,
        players: [{ id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
        creatures: [{ id: 9, kind: 'slime', x: 0, y: 0, z: 0, yaw: 0, hp: 2, max_hp: 2 }],
        hearts: [],
      },
      {
        t: 'snapshot',
        tick: 2,
        players: [
          { id: 1, x: 1, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
          { id: 2, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
        ],
        creatures: [{ id: 9, kind: 'slime', x: 0, y: 0, z: 0, yaw: 0, hp: 1, max_hp: 2 }],
        hearts: [],
      },
      {
        t: 'snapshot',
        tick: 3,
        players: [{ id: 2, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
        creatures: [],
        hearts: [{ id: 20, x: 5, y: 0, z: 0 }],
      },
    ];
    expect(r.apply(keyframe(frames[0]))).toEqual(frames[0]);
    for (let i = 1; i < frames.length; i += 1) {
      expect(r.apply(delta(frames[i - 1], frames[i]))).toEqual(frames[i]);
    }
  });
});
