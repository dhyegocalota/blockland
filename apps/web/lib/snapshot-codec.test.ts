import { describe, expect, it } from 'vitest';
import { decodeFrame, FRAME_DELTA, FRAME_KEYFRAME } from './snapshot-codec';
import { SnapshotReconstructor } from './snapshot-delta';

// Decode a hex string into the ArrayBuffer the WebSocket would hand us as a binary frame.
function fromHex(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

// The EXACT keyframe bytes the Rust encoder produces for the shared fixture in
// `apps/server/crates/protocol/src/snapshot_codec.rs` (`KEYFRAME_FIXTURE_HEX`). The cross-language safety
// net: the Rust test asserts these bytes; this test decodes them and asserts the named object. If one
// side's hex changes, the other must change with it — the codecs must agree byte-for-byte.
const KEYFRAME_FIXTURE_HEX =
  '0100d204000000000000010001000000fa00000019190000e0fcffff1f0000000500000014000000060000000301006400000004d4feffffce180000200300001400000002030100c80000000cfeffffce1800006e000000';

// The matching DELTA fixture (`DELTA_FIXTURE_HEX` in the Rust test): the same baseline (tick 1234), then a
// next at tick 1235 that moves the player (x 2.5 -> 3.0) and drops the heart. Applied onto the keyframe.
const DELTA_FIXTURE_HEX =
  '0101d304000000000000d2040000000000000100010000002c01000019190000e0fcffff1f0000000500000014000000060000000300000000000000000100c8000000';

describe('snapshot binary codec', () => {
  it('decodes the shared Rust keyframe fixture into the named shape', () => {
    const frame = decodeFrame(fromHex(KEYFRAME_FIXTURE_HEX));
    expect(frame.kind).toBe(FRAME_KEYFRAME);
    if (frame.kind !== FRAME_KEYFRAME) throw new Error('expected keyframe');
    expect(frame.snapshot).toEqual({
      t: 'snapshot',
      tick: 1234,
      players: [{ id: 1, x: 2.5, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 6, hp: 3 }],
      creatures: [{ id: 100, kind: 'spider', x: -3, y: 63.5, z: 8, yaw: 0.2, hp: 2, max_hp: 3 }],
      hearts: [{ id: 200, x: -5, y: 63.5, z: 1.1 }],
    });
  });

  it('applies the shared Rust delta fixture onto the keyframe and reconstructs the full snapshot', () => {
    const reconstructor = new SnapshotReconstructor();
    reconstructor.apply(fromHex(KEYFRAME_FIXTURE_HEX));
    const next = reconstructor.apply(fromHex(DELTA_FIXTURE_HEX));
    expect(next).toEqual({
      t: 'snapshot',
      tick: 1235,
      players: [{ id: 1, x: 3, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 6, hp: 3 }],
      creatures: [{ id: 100, kind: 'spider', x: -3, y: 63.5, z: 8, yaw: 0.2, hp: 2, max_hp: 3 }],
      hearts: [],
    });
  });

  it('classifies the delta fixture as a delta against the keyframe tick', () => {
    const frame = decodeFrame(fromHex(DELTA_FIXTURE_HEX));
    expect(frame.kind).toBe(FRAME_DELTA);
    if (frame.kind !== FRAME_DELTA) throw new Error('expected delta');
    expect(frame.tick).toBe(1235);
    expect(frame.baselineTick).toBe(1234);
    expect(frame.changedPlayers.map((p) => p.id)).toEqual([1]);
    expect(frame.removedHearts).toEqual([200]);
  });

  it('decodes an empty keyframe', () => {
    const frame = decodeFrame(fromHex('01000000000000000000000000000000'));
    expect(frame.kind).toBe(FRAME_KEYFRAME);
    if (frame.kind !== FRAME_KEYFRAME) throw new Error('expected keyframe');
    expect(frame.snapshot).toEqual({ t: 'snapshot', tick: 0, players: [], creatures: [], hearts: [] });
  });

  it('round-trips negative and centimetre-fractional coordinates in a keyframe', () => {
    // Manually build one player whose coords are not whole numbers: x=-1.23, y=0.07, z=99.99, yaw=-3.14.
    const hex =
      '01' + // version
      '00' + // keyframe kind
      '0000000000000000' + // tick 0
      '0100' + // 1 player
      '07000000' + // id 7
      cm(-1.23) +
      cm(0.07) +
      cm(99.99) +
      cm(-3.14) +
      cm(0) + // pitch
      '00000000' + // ping_ms
      '00000000' + // score
      '03' + // hp
      '0000' + // 0 creatures
      '0000'; // 0 hearts
    const frame = decodeFrame(fromHex(hex));
    if (frame.kind !== FRAME_KEYFRAME) throw new Error('expected keyframe');
    const player = frame.snapshot.players[0];
    expect(player.x).toBeCloseTo(-1.23, 2);
    expect(player.y).toBeCloseTo(0.07, 2);
    expect(player.z).toBeCloseTo(99.99, 2);
    expect(player.yaw).toBeCloseTo(-3.14, 2);
  });

  it('decodes every creature kind index and max u32 ids and full/zero hp', () => {
    const kinds = ['pig', 'chicken', 'cow', 'slime', 'spider'];
    const records = kinds
      .map((_, i) => 'ffffffff' + i.toString(16).padStart(2, '0') + cm(0).repeat(4) + (i % 2 === 0 ? '00' : 'ff') + 'ff')
      .join('');
    const hex = '01' + '00' + '0000000000000000' + '0000' + '0500' + records + '0000';
    const frame = decodeFrame(fromHex(hex));
    if (frame.kind !== FRAME_KEYFRAME) throw new Error('expected keyframe');
    expect(frame.snapshot.creatures.map((c) => c.kind)).toEqual(kinds);
    expect(frame.snapshot.creatures.every((c) => c.id === 0xffffffff)).toBe(true);
  });

  it('rejects an unknown version tag', () => {
    expect(() => decodeFrame(fromHex('99' + '00' + '0000000000000000' + '000000000000'))).toThrow();
  });
});

// Encode one f32 as little-endian i32 centimetres hex, matching the Rust `cm` writer.
function cm(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, Math.round(value * 100), true);
  return [...new Uint8Array(view.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
