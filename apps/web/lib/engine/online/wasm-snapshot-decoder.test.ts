import { describe, expect, it } from 'vitest';
import { decodeSnapshot } from './wasm-snapshot-decoder';
import { createTestSnapshotDecoder } from './wasm-test-loader';
import { encodeKeyframe, encodeDelta } from './snapshot-test-codec';
import type { WasmSnapshotDecoder } from './wasm-core-loader';
import type { SnapshotMsg } from '../../net-snapshot';

// The REAL wasm decoder (loaded in Node via `wasm-test-loader`), so the cross-language parity is a CI test,
// not just a live check: it runs the Rust `snapshot_codec` decode the server encodes against. Frames are
// synthesized with the test-only encoder (`snapshot-test-codec`), which mirrors the same wire layout.
async function newDecoder(): Promise<WasmSnapshotDecoder> {
  return createTestSnapshotDecoder();
}

// The EXACT Rust-encoded fixtures pinned in `crates/protocol/src/snapshot_codec.rs` (KEYFRAME_FIXTURE_HEX /
// DELTA_FIXTURE_HEX) — the same bytes the deleted TS codec test decoded. The cross-language safety net: if
// either side's hex changes, this test breaks until both agree byte-for-byte.
const KEYFRAME_FIXTURE_HEX =
  '0100d204000000000000010001000000fa00000019190000e0fcffff1f0000000500000014000000060000000301006400000004d4feffffce180000200300001400000002030100c80000000cfeffffce1800006e000000';
const DELTA_FIXTURE_HEX =
  '0101d304000000000000d2040000000000000100010000002c01000019190000e0fcffff1f0000000500000014000000060000000300000000000000000100c8000000';

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

describe('wasm snapshot decoder (single Rust decode)', () => {
  it('decodes the shared Rust keyframe fixture into the named snapshot', async () => {
    const decoder = await newDecoder();
    const snapshot = decodeSnapshot(decoder, fromHex(KEYFRAME_FIXTURE_HEX));
    expect(snapshot).toEqual<SnapshotMsg>({
      t: 'snapshot',
      tick: 1234,
      players: [{ id: 1, x: 2.5, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 6, hp: 3 }],
      creatures: [{ id: 100, kind: 'spider', x: -3, y: 63.5, z: 8, yaw: 0.2, hp: 2, max_hp: 3 }],
      hearts: [{ id: 200, x: -5, y: 63.5, z: 1.1 }],
    });
    decoder.free();
  });

  it('applies the shared Rust delta fixture onto the keyframe baseline', async () => {
    const decoder = await newDecoder();
    decodeSnapshot(decoder, fromHex(KEYFRAME_FIXTURE_HEX));
    const next = decodeSnapshot(decoder, fromHex(DELTA_FIXTURE_HEX));
    expect(next).toEqual<SnapshotMsg>({
      t: 'snapshot',
      tick: 1235,
      players: [{ id: 1, x: 3, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 6, hp: 3 }],
      creatures: [{ id: 100, kind: 'spider', x: -3, y: 63.5, z: 8, yaw: 0.2, hp: 2, max_hp: 3 }],
      hearts: [],
    });
    decoder.free();
  });

  it('emits nothing for a delta with no usable baseline (no keyframe yet)', async () => {
    const decoder = await newDecoder();
    expect(decodeSnapshot(decoder, fromHex(DELTA_FIXTURE_HEX))).toBeNull();
    decoder.free();
  });

  it('decodes an empty keyframe', async () => {
    const decoder = await newDecoder();
    expect(decodeSnapshot(decoder, fromHex('01000000000000000000000000000000'))).toEqual<SnapshotMsg>({
      t: 'snapshot',
      tick: 0,
      players: [],
      creatures: [],
      hearts: [],
    });
    decoder.free();
  });

  it('round-trips negative + centimetre-fractional coords like the old TS path', async () => {
    const decoder = await newDecoder();
    const cm = (value: number): string => {
      const view = new DataView(new ArrayBuffer(4));
      view.setInt32(0, Math.round(value * 100), true);
      return [...new Uint8Array(view.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const hex =
      '01' + '00' + '0000000000000000' + '0100' + '07000000' +
      cm(-1.23) + cm(0.07) + cm(99.99) + cm(-3.14) + cm(0) + '00000000' + '00000000' + '03' + '0000' + '0000';
    const snapshot = decodeSnapshot(decoder, fromHex(hex));
    if (!snapshot) throw new Error('expected a snapshot');
    const player = snapshot.players[0];
    expect(player.x).toBeCloseTo(-1.23, 2);
    expect(player.y).toBeCloseTo(0.07, 2);
    expect(player.z).toBeCloseTo(99.99, 2);
    expect(player.yaw).toBeCloseTo(-3.14, 2);
    decoder.free();
  });

  it('throws on a stale version byte', async () => {
    const decoder = await newDecoder();
    expect(() => decodeSnapshot(decoder, fromHex('99' + '00' + '0000000000000000' + '000000000000'))).toThrow();
    decoder.free();
  });

  // Reconstruction over a varied keyframe + delta stream (move/join/leave/heart-drop across all three
  // categories): each reconstructed frame must equal the full snapshot the server encoded. This is the
  // end-to-end no-regression proof the decode move keeps — it reproduced the OLD TS reconstructor frame-for-
  // frame while that code still existed (run `git show` for that guard); the codec now lives only in Rust.
  it('reconstructs a varied keyframe + delta stream frame-for-frame', async () => {
    const keyframe: SnapshotMsg = {
      t: 'snapshot',
      tick: 1,
      players: [
        { id: 1, x: 2.5, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 6, hp: 3 },
        { id: 2, x: -1.23, y: 0.07, z: 99.99, yaw: -3.14, pitch: 0.5, ping_ms: 40, score: 0, hp: 1 },
      ],
      creatures: [
        { id: 100, kind: 'spider', x: -3, y: 63.5, z: 8, yaw: 0.2, hp: 2, max_hp: 3 },
        { id: 101, kind: 'pig', x: 12.34, y: 64, z: -5.5, yaw: 1.1, hp: 2, max_hp: 2 },
      ],
      hearts: [{ id: 200, x: -5, y: 63.5, z: 1.1 }],
    };
    // A sequence that exercises move/join/leave/heart-drop across all three categories.
    const nexts: SnapshotMsg[] = [
      {
        t: 'snapshot',
        tick: 2,
        players: [
          { id: 1, x: 3, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 7, hp: 3 },
          { id: 3, x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, ping_ms: 15, score: 0, hp: 3 },
        ],
        creatures: [{ id: 100, kind: 'spider', x: -3.5, y: 63.5, z: 8, yaw: 0.25, hp: 1, max_hp: 3 }],
        hearts: [{ id: 200, x: -5, y: 63.5, z: 1.1 }, { id: 201, x: 7.7, y: 63.5, z: -2.2 }],
      },
      {
        t: 'snapshot',
        tick: 3,
        players: [{ id: 3, x: 0.5, y: 64, z: 1.5, yaw: 0.1, pitch: -0.2, ping_ms: 18, score: 1, hp: 3 }],
        creatures: [],
        hearts: [],
      },
    ];

    const wasmDecoder = await newDecoder();
    expect(decodeSnapshot(wasmDecoder, encodeKeyframe(keyframe))).toEqual(keyframe);

    let baseline = keyframe;
    for (const next of nexts) {
      const reconstructed = decodeSnapshot(wasmDecoder, encodeDelta(baseline, next));
      expect(reconstructed).toEqual(next);
      baseline = next;
    }
    wasmDecoder.free();
  });
});
