import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNet, type NetState, type WebSocketLike } from './net';

class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];

  readyState: number = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const welcome = {
  t: 'welcome',
  you: 1,
  tenant: 'acme',
  world: 'main',
  brand: { name: 'Acme', image: '/tenants/acme/avatar.png' },
  tick_hz: 20,
  spawn: [0, 0, 0],
  admin: false,
  moderator: false,
  version: 'test',
};

function makeClient(overrides: Partial<Parameters<typeof createNet>[0]> = {}) {
  const states: NetState[] = [];
  const snapshots: unknown[] = [];
  let clock = 1_000;
  const client = createNet({
    url: 'ws://test',
    tenant: 'acme',
    world: 'main',
    name: 'Bot',
    skin: '#f2c18b',
    shirt: '#ff5d2e',
    hair: '#3a2a1a',
    claim: 'claim-tok',
    handlers: {
      onState: (s) => states.push(s),
      onSnapshot: (m) => snapshots.push(m),
    },
    socketFactory: (url) => new MockWebSocket(url),
    now: () => clock,
    ...overrides,
  });
  return {
    client,
    states,
    snapshots,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

describe('net client', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect -> open -> welcome transitions to online', () => {
    const { client, states } = makeClient();
    client.connect();
    expect(client.state).toBe('connecting');

    const socket = MockWebSocket.instances[0];
    socket.open();
    expect(socket.sent[0]).toBe(JSON.stringify({ t: 'join', tenant: 'acme', world: 'main', name: 'Bot', skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a', claim: 'claim-tok' }));

    socket.receive(welcome);
    expect(client.state).toBe('online');
    expect(states).toEqual(['connecting', 'online']);
  });

  it('decodes a compact numeric snapshot into the named shape', () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({
      t: 'snapshot',
      k: 5,
      p: [[1, 2.5, 3, 4, 0.1, 0.2, 30, 7, 3]],
      c: [[9, 3, 10, 11, 12, 1.5, 2, 4]],
      h: [[2, 20, 21, 22]],
    });
    expect(snapshots).toEqual([
      {
        t: 'snapshot',
        tick: 5,
        players: [{ id: 1, x: 2.5, y: 3, z: 4, yaw: 0.1, pitch: 0.2, ping_ms: 30, score: 7, hp: 3 }],
        creatures: [{ id: 9, kind: 'slime', x: 10, y: 11, z: 12, yaw: 1.5, hp: 2, max_hp: 4 }],
        hearts: [{ id: 2, x: 20, y: 21, z: 22 }],
      },
    ]);
  });

  it('tolerates a snapshot from an older server with no heart-drop field', () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'snapshot', k: 6, p: [], c: [] });
    expect(snapshots).toEqual([{ t: 'snapshot', tick: 6, players: [], creatures: [], hearts: [] }]);
  });

  it('routes edit_batch to onEditBatch and serializes sendEditBatch', () => {
    const batches: unknown[] = [];
    const { client } = makeClient({ handlers: { onEditBatch: (m) => batches.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    const incoming = { t: 'edit_batch', edits: [{ x: 1, y: 2, z: 3, id: 4 }], by: 7 };
    socket.receive(incoming);
    expect(batches).toEqual([incoming]);

    client.sendEditBatch([{ x: 5, y: 6, z: 7, id: 8 }]);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'edit_batch', edits: [{ x: 5, y: 6, z: 7, id: 8 }] }));
  });

  it('a banned error transitions to banned and does not reconnect', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'error', code: 'banned', msg: 'you are banned' });
    expect(client.state).toBe('banned');

    socket.serverClose();
    expect(client.state).toBe('banned');

    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('an admin kick does not reconnect', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'error', code: 'kicked', msg: 'removed by an admin' });
    expect(client.state).toBe('kicked');

    socket.serverClose();
    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('an unexpected close reconnects and a successful reopen goes online', () => {
    const { client, states } = makeClient();
    client.connect();
    const first = MockWebSocket.instances[0];
    first.open();
    first.receive(welcome);

    first.serverClose();
    expect(client.state).toBe('reconnecting');

    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = MockWebSocket.instances[1];
    second.open();
    second.receive(welcome);
    expect(client.state).toBe('online');
    expect(states).toEqual(['connecting', 'online', 'reconnecting', 'online']);
  });

  it('reconnect backoff grows per attempt and a Welcome resets it', () => {
    const { client, states } = makeClient();
    client.connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].receive(welcome);

    // First drop: reconnecting, reopen at the base backoff (500ms), not before.
    MockWebSocket.instances[0].serverClose();
    expect(client.state).toBe('reconnecting');
    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // The reopen fails to welcome and drops again: the backoff doubles to 1000ms.
    MockWebSocket.instances[1].serverClose();
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // A Welcome lands: back online and the attempt counter is reset, so the NEXT drop waits only the
    // base 500ms again (not the doubled 2000ms it would be had the counter kept climbing).
    MockWebSocket.instances[2].open();
    MockWebSocket.instances[2].receive(welcome);
    expect(client.state).toBe('online');
    MockWebSocket.instances[2].serverClose();
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(4);
    // The mid-sequence re-drop stays in 'reconnecting' (setState dedupes), so it isn't pushed twice.
    expect(states).toEqual(['connecting', 'online', 'reconnecting', 'online', 'reconnecting']);
  });

  it('a user-initiated close does not reconnect (offline, no reopen)', () => {
    const { client, states } = makeClient();
    client.connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].receive(welcome);

    client.close();
    expect(client.state).toBe('offline');
    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(states).toEqual(['connecting', 'online', 'offline']);
  });

  it('ping/pong replies with pong and updates ping', () => {
    const { client, setClock } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    setClock(1_000);
    socket.receive({ t: 'ping', nonce: 42 });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'pong', nonce: 42 }));

    setClock(1_080);
    socket.receive({ t: 'ping', nonce: 43 });
    expect(client.ping).toBe(80);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'pong', nonce: 43 }));
  });

  it('sendMove and sendChat serialize the right JSON', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    client.sendMove(1, 2, 3, 0.5, -0.2);
    client.sendChat('hello');
    expect(socket.sent.at(-2)).toBe(JSON.stringify({ t: 'move', x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2 }));
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'chat', text: 'hello' }));
  });

  it('sendHit serializes the attacked creature id', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    client.sendHit(7);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'hit', id: 7 }));
  });

  it('routes a timeline event to onEvent', () => {
    const events: unknown[] = [];
    const { client } = makeClient({ handlers: { onEvent: (m) => events.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'event', kind: 'rename', name: 'Bea', detail: 'Ana' });
    expect(events).toEqual([{ t: 'event', kind: 'rename', name: 'Bea', detail: 'Ana' }]);
  });

  it('routes room_state to onRoomState', () => {
    const states: unknown[] = [];
    const { client } = makeClient({ handlers: { onRoomState: (m) => states.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    const incoming = { t: 'room_state', peace: true, blocked_structures: ['bottle', 'hero'], pvp: false, chat_enabled: true };
    socket.receive(incoming);
    expect(states).toEqual([incoming]);
  });

  it('routes roster to onRoster', () => {
    const rosters: unknown[] = [];
    const { client } = makeClient({ handlers: { onRoster: (m) => rosters.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    const incoming = { t: 'roster', players: [{ id: 7, name: 'Kid', skin: '#abc', shirt: '#def', hair: '#123' }] };
    socket.receive(incoming);
    expect(rosters).toEqual([incoming]);
  });

  it('routes pending_approvals to onPendingApprovals', () => {
    const lists: unknown[] = [];
    const { client } = makeClient({ handlers: { onPendingApprovals: (m) => lists.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    const incoming = { t: 'pending_approvals', pending: [{ account_id: 'a1', name: 'Kid', email: 'kid@x.com' }] };
    socket.receive(incoming);
    expect(lists).toEqual([incoming]);
  });

  it('routes bans to onBans', () => {
    const lists: unknown[] = [];
    const { client } = makeClient({ handlers: { onBans: (m) => lists.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    const incoming = { t: 'bans', bans: [{ ip: '1.2.3.4', name: 'Kid' }] };
    socket.receive(incoming);
    expect(lists).toEqual([incoming]);
  });

  it('a rejected hold is terminal: it stops the approval retry loop', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    socket.receive({ t: 'error', code: 'needs_approval', msg: 'waiting' });
    expect(client.state).toBe('needs_approval');

    // The admin rejects: terminal — the next close must NOT schedule another join.
    socket.receive({ t: 'error', code: 'rejected', msg: 'no' });
    expect(client.state).toBe('rejected');
    const before = MockWebSocket.instances.length;
    socket.serverClose();
    vi.runAllTimers();
    expect(MockWebSocket.instances.length).toBe(before);
    expect(client.state).toBe('rejected');
  });

  it('serializes admin reject and unban messages', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    client.sendAdminReject('acc1');
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_reject', account_id: 'acc1' }));
    client.sendAdminBanPending('ip:1.2.3.4');
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_ban_pending', account_id: 'ip:1.2.3.4' }));
    client.sendAdminUnban('1.2.3.4');
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_unban', ip: '1.2.3.4' }));
  });

  it('a needs_approval hold freezes on a waiting state and silently re-joins until approved', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    // Held for approval: not terminal — stays on the waiting screen and re-joins after the close.
    socket.receive({ t: 'error', code: 'needs_approval', msg: 'waiting' });
    expect(client.state).toBe('needs_approval');
    socket.serverClose();
    vi.runAllTimers();
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    expect(client.state).toBe('needs_approval');

    // The admin approves: the retry's Welcome drops the player straight in.
    const retry = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    retry.open();
    retry.receive(welcome);
    expect(client.state).toBe('online');
  });

  it('serializes admin approval toggle and approve messages', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    client.sendAdminSetApproval(true);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_set_approval', on: true }));
    client.sendAdminApprove('acc1');
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_approve', account_id: 'acc1' }));
  });

  it('routes hurt to onHurt', () => {
    const hits: unknown[] = [];
    const { client } = makeClient({ handlers: { onHurt: (m) => hits.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'hurt', by: 'Maria' });
    expect(hits).toEqual([{ t: 'hurt', by: 'Maria' }]);
  });

  it('routes swing to onSwing', () => {
    const swings: unknown[] = [];
    const { client } = makeClient({ handlers: { onSwing: (m) => swings.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'swing', id: 7 });
    expect(swings).toEqual([{ t: 'swing', id: 7 }]);
  });

  it('routes inventory to onInventory and serializes sendAdminSetInfinite', () => {
    const inventories: unknown[] = [];
    const { client } = makeClient({ handlers: { onInventory: (m) => inventories.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'inventory', items: [{ id: 3, count: 2 }], infinite: false });
    expect(inventories).toEqual([{ t: 'inventory', items: [{ id: 3, count: 2 }], infinite: false }]);

    client.sendAdminSetInfinite(true);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_set_infinite', on: true }));
  });

  it('sendAdminSetPeace and sendAdminSetStructure serialize the right JSON', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    client.sendAdminSetPeace(true);
    client.sendAdminSetStructure('cola', false);
    expect(socket.sent.at(-2)).toBe(JSON.stringify({ t: 'admin_set_peace', on: true }));
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_set_structure', kind: 'cola', allowed: false }));
  });

  it('serializes pvp/chat/kick/ban admin and attack_player messages', () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    client.sendAdminSetPvp(true);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_set_pvp', on: true }));
    client.sendAdminSetChat(false);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_set_chat', on: false }));
    client.sendAdminKick(3);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_kick', id: 3 }));
    client.sendAdminBan(4);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_ban', id: 4 }));
    client.sendAttackPlayer(5);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'attack_player', id: 5 }));
    client.sendAdminResetWorld();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'admin_reset_world' }));
  });

  it('does not reconnect when reconnect is disabled', () => {
    const { client } = makeClient({ reconnect: false });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.serverClose();
    expect(client.state).toBe('offline');
    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
