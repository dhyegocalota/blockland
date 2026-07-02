import { describe, it, expect } from 'vitest';
import { adminApprove, adminBan, adminBanPending, adminKick, adminResetWorld, adminSetApproval, adminSetChat, adminSetInfinite, adminSetPeace, adminSetPvp, adminSetRole, adminSetStructure, attackPlayer, chat, edit, encodeClientMsg, hit, join, move, parseServerMsg, pong, type ClientMsg, type EncodeClientMsg } from './protocol';
import { createTestClientEncoder } from './engine/online/wasm-test-loader';

// The cross-language safety net: these EXACT hex strings are pinned in `apps/server/crates/protocol/src/
// client_codec.rs` (encodes_representative_messages_to_exact_bytes). The wasm encoder below — the SAME Rust
// codec the server decodes against — must produce byte-identical frames. If a fixture changes, update BOTH.
const MOVE_FIXTURE_HEX = '010000c03f00001040000000c152b89e3ecdcc4cbd';
const EDIT_FIXTURE_HEX = '02000a000000fdffffff0700000004';
const JOIN_FIXTURE_HEX =
  '00040061636d6504006d61696e0200426f0700236632633138620700236666356432650700233361326131610300746f6b00';
const CHAT_FIXTURE_HEX = '0408006869207468657265';
const PONG_FIXTURE_HEX = '032a000000';

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function encodeHex(encode: EncodeClientMsg, msg: ClientMsg): string {
  return toHex(encodeClientMsg(encode, msg));
}

describe('protocol factories', () => {
  it('builds a join message', () => {
    const look = { skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a' };
    expect(join({ tenant: 'acme', world: 'main', name: 'Bot', claim: 'tok', observer: false, ...look })).toEqual({ t: 'join', tenant: 'acme', world: 'main', name: 'Bot', claim: 'tok', observer: false, ...look });
  });

  it('builds a move message', () => {
    expect(move(1, 2, 3, 0.5, -0.2)).toEqual({ t: 'move', x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2 });
  });

  it('builds place/break edit messages', () => {
    expect(edit('place', 1, 2, 3, 8)).toEqual({ t: 'edit', op: 'place', x: 1, y: 2, z: 3, id: 8 });
    expect(edit('break', 4, 5, 6, 0)).toEqual({ t: 'edit', op: 'break', x: 4, y: 5, z: 6, id: 0 });
  });

  it('builds pong and chat', () => {
    expect(pong(7)).toEqual({ t: 'pong', nonce: 7 });
    expect(chat('hi')).toEqual({ t: 'chat', text: 'hi' });
  });

  it('builds a hit message', () => {
    expect(hit(42)).toEqual({ t: 'hit', id: 42 });
  });

  it('builds admin set-peace and set-structure messages', () => {
    expect(adminSetPeace(true)).toEqual({ t: 'admin_set_peace', on: true });
    expect(adminSetStructure('cola', false)).toEqual({ t: 'admin_set_structure', kind: 'cola', allowed: false });
  });

  it('builds pvp/chat toggles, kick/ban and attack-player messages', () => {
    expect(adminSetPvp(true)).toEqual({ t: 'admin_set_pvp', on: true });
    expect(adminSetChat(false)).toEqual({ t: 'admin_set_chat', on: false });
    expect(adminKick(3)).toEqual({ t: 'admin_kick', id: 3 });
    expect(adminBan(4)).toEqual({ t: 'admin_ban', id: 4 });
    expect(attackPlayer(5)).toEqual({ t: 'attack_player', id: 5 });
  });

  it('builds an admin reset-world message', () => {
    expect(adminResetWorld()).toEqual({ t: 'admin_reset_world' });
    expect(adminSetRole(7, 'moderator')).toEqual({ t: 'admin_set_role', id: 7, role: 'moderator' });
  });

  it('builds an admin set-infinite message', () => {
    expect(adminSetInfinite(false)).toEqual({ t: 'admin_set_infinite', on: false });
  });

  it('parses a server inventory message', () => {
    const inv = parseServerMsg('{"t":"inventory","items":[{"id":3,"count":2}],"infinite":false}');
    expect(inv.t).toBe('inventory');
    if (inv.t === 'inventory') {
      expect(inv.infinite).toBe(false);
      expect(inv.items).toEqual([{ id: 3, count: 2 }]);
    }
  });

  it('builds approval toggle and approve messages', () => {
    expect(adminSetApproval(true)).toEqual({ t: 'admin_set_approval', on: true });
    expect(adminApprove('acc1')).toEqual({ t: 'admin_approve', account_id: 'acc1' });
    expect(adminBanPending('ip:1.2.3.4')).toEqual({ t: 'admin_ban_pending', account_id: 'ip:1.2.3.4' });
  });

  it('parses a compact server snapshot', () => {
    const snap = parseServerMsg('{"t":"snapshot","k":5,"p":[],"c":[]}');
    expect(snap.t).toBe('snapshot');
    if (snap.t === 'snapshot') expect(snap.k).toBe(5);
  });
});

// The client encodes every `ClientMsg` to binary through the SHARED Rust codec (the wasm `encode_client_msg`),
// never a hand-written TS encoder. These assert the wasm output is byte-for-byte the Rust fixture bytes — the
// cross-language safety net that keeps client + server in lock-step.
describe('binary client codec (shared Rust codec via wasm)', () => {
  it('encodes a Move to the exact Rust fixture bytes', async () => {
    const encode = await createTestClientEncoder();
    expect(encodeHex(encode, move(1.5, 2.25, -8, 0.31, -0.05))).toBe(MOVE_FIXTURE_HEX);
  });

  it('encodes a place Edit to the exact Rust fixture bytes', async () => {
    const encode = await createTestClientEncoder();
    expect(encodeHex(encode, edit('place', 10, -3, 7, 4))).toBe(EDIT_FIXTURE_HEX);
  });

  it('encodes a Join (length-prefixed strings) to the exact Rust fixture bytes', async () => {
    const encode = await createTestClientEncoder();
    const msg = join({ tenant: 'acme', world: 'main', name: 'Bo', skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a', claim: 'tok', observer: false });
    expect(encodeHex(encode, msg)).toBe(JOIN_FIXTURE_HEX);
  });

  it('encodes Chat + Pong to the exact Rust fixture bytes', async () => {
    const encode = await createTestClientEncoder();
    expect(encodeHex(encode, chat('hi there'))).toBe(CHAT_FIXTURE_HEX);
    expect(encodeHex(encode, pong(42))).toBe(PONG_FIXTURE_HEX);
  });

  it('encodes every variant to a non-empty frame whose tag byte is distinct', async () => {
    const encode = await createTestClientEncoder();
    const everyVariant: ClientMsg[] = [
      join({ tenant: 'acme', world: 'main', name: 'Bo', skin: 's', shirt: 'h', hair: 'r', claim: 'c', observer: false }),
      move(1, 2, 3, 0.5, -0.2),
      edit('place', 10, -3, 7, 4),
      pong(42),
      chat('hi'),
      hit(7),
      { t: 'edit_batch', edits: [{ x: 1, y: 2, z: 3, id: 5 }] },
      adminSetPeace(true),
      adminSetStructure('cola', false),
      adminSetPvp(false),
      adminSetChat(true),
      adminSetInfinite(true),
      adminKick(3),
      adminBan(4),
      attackPlayer(5),
      adminResetWorld(),
      { t: 'admin_reset_scores' },
      { t: 'admin_suspend', on: true },
      adminSetRole(9, 'moderator'),
      adminSetApproval(false),
      adminApprove('acc1'),
      { t: 'admin_reject', account_id: 'acc2' },
      adminBanPending('ip:1.2.3.4'),
      { t: 'admin_unban', ip: '1.2.3.4' },
      { t: 'admin_set_limits', playtime_limit_min: 30, playtime_window_h: 24 },
      { t: 'admin_set_modes', online_allowed: true, offline_allowed: false },
      { t: 'respawn' },
      { t: 'dig', x: -1, y: 64, z: 200 },
    ];
    const tags = everyVariant.map((msg) => {
      const bytes = encodeClientMsg(encode, msg);
      expect(bytes.length).toBeGreaterThan(0);
      return bytes[0];
    });
    expect(new Set(tags).size).toBe(everyVariant.length);
  });
});
