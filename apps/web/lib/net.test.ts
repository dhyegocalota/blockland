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
  tenant: 'teo',
  world: 'main',
  brand: { name: 'Teocraft', primary: '#fff', logo: null },
  tick_hz: 20,
  spawn: [0, 0, 0],
  admin: false,
};

function makeClient(overrides: Partial<Parameters<typeof createNet>[0]> = {}) {
  const states: NetState[] = [];
  const snapshots: unknown[] = [];
  let clock = 1_000;
  const client = createNet({
    url: 'ws://test',
    tenant: 'teo',
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
    expect(socket.sent[0]).toBe(JSON.stringify({ t: 'join', tenant: 'teo', world: 'main', name: 'Bot', skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a', claim: 'claim-tok' }));

    socket.receive(welcome);
    expect(client.state).toBe('online');
    expect(states).toEqual(['connecting', 'online']);
  });

  it('receiving a snapshot calls onSnapshot', () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    socket.receive({ t: 'snapshot', tick: 5, players: [] });
    expect(snapshots).toEqual([{ t: 'snapshot', tick: 5, players: [] }]);
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

    const incoming = { t: 'room_state', peace: true, blocked_structures: ['cola', 'steve'], pvp: false, chat_enabled: true };
    socket.receive(incoming);
    expect(states).toEqual([incoming]);
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
