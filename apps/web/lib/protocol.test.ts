import { describe, it, expect } from 'vitest';
import { chat, edit, encodeClientMsg, join, move, parseServerMsg, pong } from './protocol';

describe('protocol factories', () => {
  it('builds a join message', () => {
    expect(join('teo', 'main', 'Bot')).toEqual({ t: 'join', tenant: 'teo', world: 'main', name: 'Bot' });
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
