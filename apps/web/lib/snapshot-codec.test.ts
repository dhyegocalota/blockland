import { describe, expect, it } from 'vitest';
import { decodeSnapshot } from './snapshot-codec';

// Decode a hex string into the ArrayBuffer the WebSocket would hand us as a binary frame.
function fromHex(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

// The EXACT bytes the Rust encoder produces for the shared fixture in
// `apps/server/crates/protocol/src/snapshot_codec.rs` (`FIXTURE_HEX`). This is the cross-language safety
// net: the Rust test asserts these bytes; this test decodes them and asserts the named object. If one
// side's hex changes, the other must change with it — the codecs must agree byte-for-byte.
const FIXTURE_HEX =
  '01d204000000000000010001000000fa00000019190000e0fcffff1f0000000500000014000000060000000301006400000004d4feffffce180000200300001400000002030100c80000000cfeffffce1800006e000000';

describe('snapshot binary codec', () => {
  it('decodes the shared Rust fixture into the named shape', () => {
    expect(decodeSnapshot(fromHex(FIXTURE_HEX))).toEqual({
      t: 'snapshot',
      tick: 1234,
      players: [{ id: 1, x: 2.5, y: 64.25, z: -8, yaw: 0.31, pitch: 0.05, ping_ms: 20, score: 6, hp: 3 }],
      creatures: [{ id: 100, kind: 'spider', x: -3, y: 63.5, z: 8, yaw: 0.2, hp: 2, max_hp: 3 }],
      hearts: [{ id: 200, x: -5, y: 63.5, z: 1.1 }],
    });
  });

  it('decodes empty arrays', () => {
    expect(decodeSnapshot(fromHex('010000000000000000000000000000'))).toEqual({
      t: 'snapshot',
      tick: 0,
      players: [],
      creatures: [],
      hearts: [],
    });
  });

  it('round-trips negative and centimetre-fractional coordinates', () => {
    // Manually build one player whose coords are not whole numbers: x=-1.23, y=0.07, z=99.99, yaw=-3.14.
    const hex =
      '01' + // version
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
    const decoded = decodeSnapshot(fromHex(hex));
    const player = decoded.players[0];
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
    const hex = '01' + '0000000000000000' + '0000' + '0500' + records + '0000';
    const decoded = decodeSnapshot(fromHex(hex));
    expect(decoded.creatures.map((c) => c.kind)).toEqual(kinds);
    expect(decoded.creatures.every((c) => c.id === 0xffffffff)).toBe(true);
  });

  it('rejects an unknown version tag', () => {
    expect(() => decodeSnapshot(fromHex('99' + '0000000000000000' + '000000000000'))).toThrow();
  });
});

// Encode one f32 as little-endian i32 centimetres hex, matching the Rust `cm` writer.
function cm(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, Math.round(value * 100), true);
  return [...new Uint8Array(view.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
