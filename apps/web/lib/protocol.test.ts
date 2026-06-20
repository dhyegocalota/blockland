import { describe, it, expect } from 'vitest';
import { adminBan, adminKick, adminResetWorld, adminSetChat, adminSetPeace, adminSetPvp, adminSetStructure, attackPlayer, chat, edit, encodeClientMsg, hit, join, move, parseServerMsg, pong } from './protocol';

describe('protocol factories', () => {
  it('builds a join message', () => {
    const look = { skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a' };
    expect(join({ tenant: 'teo', world: 'main', name: 'Bot', claim: 'tok', ...look })).toEqual({ t: 'join', tenant: 'teo', world: 'main', name: 'Bot', claim: 'tok', ...look });
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

  it('builds a hit message and round-trips it through JSON', () => {
    expect(hit(42)).toEqual({ t: 'hit', id: 42 });
    expect(JSON.parse(encodeClientMsg(hit(42)))).toEqual({ t: 'hit', id: 42 });
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
  });

  it('round-trips a client message through JSON', () => {
    const msg = move(10, 11, 12, 1, 2);
    expect(JSON.parse(encodeClientMsg(msg))).toEqual(msg);
  });

  it('parses a server snapshot', () => {
    const snap = parseServerMsg('{"t":"snapshot","tick":5,"players":[]}');
    expect(snap.t).toBe('snapshot');
    if (snap.t === 'snapshot') expect(snap.tick).toBe(5);
  });
});
