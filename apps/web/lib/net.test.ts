import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNet, type NetState, type WebSocketLike } from './net';
import { encodeKeyframe, encodeDelta } from './engine/online/snapshot-test-codec';
import { createTestClientEncoder, createTestSnapshotDecoder } from './engine/online/wasm-test-loader';
import { encodeClientMsg, type ClientMsg, type EncodeClientMsg } from './protocol';
import type { SnapshotMsg } from './net-snapshot';

// A reference encoder (the SAME wasm `encode_client_msg` the client uses), so a sent binary frame can be
// asserted against the exact bytes the matching `ClientMsg` encodes to — proving the send path sends the
// right message in the new binary wire. Built once in `beforeAll`.
let refEncoder: EncodeClientMsg;

// Pre-init the real wasm decoder + encoder once so the injected factories below resolve on a microtask (the
// module is already loaded), mirroring production where the wasm is inited at boot before connect.
beforeAll(async () => {
  (await createTestSnapshotDecoder()).free();
  refEncoder = await createTestClientEncoder();
});

// Let net's `decoderFactory()`/`encoderFactory()` `.then(...)` (and any pending microtask) run, so the decoder
// + encoder are set before the test delivers a binary frame or sends — the production path has the same
// ordering (both ready before the socket opens / snapshots arrive).
async function flushWasm(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// The bytes the given `ClientMsg` encodes to through the shared codec — what a correct send must have put on
// the wire.
function frameOf(msg: ClientMsg): Uint8Array {
  return encodeClientMsg(refEncoder, msg);
}

class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];

  readyState: number = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
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

  // The per-tick snapshot is the one binary frame; deliver it as the ArrayBuffer a real socket
  // (binaryType='arraybuffer') hands the client. A keyframe carries the full snapshot; the helper below
  // delivers a delta against a baseline so the reconstructor path is exercised end-to-end.
  receiveSnapshot(snapshot: SnapshotMsg): void {
    this.deliver(encodeKeyframe(snapshot));
  }

  receiveDelta(baseline: SnapshotMsg, next: SnapshotMsg): void {
    this.deliver(encodeDelta(baseline, next));
  }

  private deliver(bytes: Uint8Array): void {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    this.onmessage?.({ data: buffer });
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
  const net = { offline: () => {}, online: () => {} };
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
    decoderFactory: createTestSnapshotDecoder,
    encoderFactory: createTestClientEncoder,
    now: () => clock,
    connectivity: {
      subscribe: (onOffline, onOnline) => {
        net.offline = onOffline;
        net.online = onOnline;
        return () => { net.offline = () => {}; net.online = () => {}; };
      },
    },
    ...overrides,
  });
  return {
    client,
    states,
    snapshots,
    net,
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

  it('connect -> open -> welcome transitions to online', async () => {
    const { client, states } = makeClient();
    client.connect();
    expect(client.state).toBe('connecting');

    const socket = MockWebSocket.instances[0];
    await flushWasm();
    socket.open();
    expect(socket.sent[0]).toEqual(frameOf({ t: 'join', tenant: 'acme', world: 'main', name: 'Bot', skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a', claim: 'claim-tok' }));

    socket.receive(welcome);
    expect(client.state).toBe('online');
    expect(states).toEqual(['connecting', 'online']);
  });

  it('decodes a binary snapshot frame into the named shape', async () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    socket.receiveSnapshot({
      t: 'snapshot',
      tick: 5,
      players: [{ id: 1, x: 2.5, y: 3, z: 4, yaw: 0.1, pitch: 0.2, ping_ms: 30, score: 7, hp: 3 }],
      creatures: [{ id: 9, kind: 'slime', x: 10, y: 11, z: 12, yaw: 1.5, hp: 2, max_hp: 4 }],
      hearts: [{ id: 2, x: 20, y: 21, z: 22 }],
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

  it('reconstructs the full snapshot from a keyframe then a delta', async () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    const keyframe: SnapshotMsg = {
      t: 'snapshot',
      tick: 5,
      players: [
        { id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
        { id: 2, x: 5, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 },
      ],
      creatures: [{ id: 9, kind: 'slime', x: 1, y: 1, z: 1, yaw: 0, hp: 2, max_hp: 4 }],
      hearts: [{ id: 7, x: 3, y: 0, z: 3 }],
    };
    // Player 1 moves, player 2 leaves; the creature stays still; the heart stays.
    const next: SnapshotMsg = {
      t: 'snapshot',
      tick: 6,
      players: [{ id: 1, x: 2, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
      creatures: keyframe.creatures,
      hearts: keyframe.hearts,
    };
    socket.receiveSnapshot(keyframe);
    socket.receiveDelta(keyframe, next);

    expect(snapshots).toEqual([keyframe, next]);
  });

  it('drops a delta whose baseline does not match the current tick, until the next keyframe', async () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    const keyframe: SnapshotMsg = {
      t: 'snapshot',
      tick: 5,
      players: [{ id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
      creatures: [],
      hearts: [],
    };
    socket.receiveSnapshot(keyframe);
    // A delta built on tick 9 — a baseline the client never saw (current is 5). It must be dropped.
    const stale: SnapshotMsg = { ...keyframe, tick: 9 };
    const next: SnapshotMsg = {
      t: 'snapshot',
      tick: 10,
      players: [{ id: 1, x: 9, y: 0, z: 0, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 3 }],
      creatures: [],
      hearts: [],
    };
    socket.receiveDelta(stale, next);
    // Only the keyframe was emitted; the stale delta was silently dropped.
    expect(snapshots).toEqual([keyframe]);

    // A fresh keyframe resyncs and emits again.
    const resync: SnapshotMsg = { ...keyframe, tick: 12 };
    socket.receiveSnapshot(resync);
    expect(snapshots).toEqual([keyframe, resync]);
  });

  it('sets binaryType to arraybuffer so the snapshot frame arrives as bytes', () => {
    const { client } = makeClient();
    client.connect();
    expect(MockWebSocket.instances[0].binaryType).toBe('arraybuffer');
  });

  it('decodes an empty binary snapshot', async () => {
    const { client, snapshots } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    socket.receiveSnapshot({ t: 'snapshot', tick: 6, players: [], creatures: [], hearts: [] });
    expect(snapshots).toEqual([{ t: 'snapshot', tick: 6, players: [], creatures: [], hearts: [] }]);
  });

  it('routes edit_batch to onEditBatch and serializes sendEditBatch', async () => {
    const batches: unknown[] = [];
    const { client } = makeClient({ handlers: { onEditBatch: (m) => batches.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    const incoming = { t: 'edit_batch', edits: [{ x: 1, y: 2, z: 3, id: 4 }], by: 7 };
    socket.receive(incoming);
    expect(batches).toEqual([incoming]);

    client.sendEditBatch([{ x: 5, y: 6, z: 7, id: 8 }]);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'edit_batch', edits: [{ x: 5, y: 6, z: 7, id: 8 }] }));
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

  it('the browser going offline reconnects immediately, not after the watchdog timeout', () => {
    const { client, net } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);
    expect(client.state).toBe('online');

    // The browser flips offline the instant the NIC drops — no clock advance, no waiting.
    net.offline();
    expect(socket.readyState).toBe(3);
    expect(client.state).toBe('reconnecting');
  });

  it('the browser coming back online retries the connection right away (skips the backoff wait)', () => {
    const { client, net } = makeClient();
    client.connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].receive(welcome);

    net.offline();
    expect(client.state).toBe('reconnecting');
    // Without the online event we'd wait out the backoff; the event reopens at once.
    net.online();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('a silently dead socket (no messages) is force-reconnected by the liveness watchdog', () => {
    const { client, setClock } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);
    expect(client.state).toBe('online');

    // No more messages arrive (internet dropped, the socket never cleanly closed). Once the silence
    // passes the liveness timeout, the watchdog closes the socket and the reconnect path kicks in.
    setClock(1_000 + 6_000);
    vi.advanceTimersByTime(6_000);
    expect(socket.readyState).toBe(3);
    expect(client.state).toBe('reconnecting');
  });

  it('a connection that keeps receiving messages is never tripped by the watchdog', () => {
    const { client, setClock } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.receive(welcome);

    // A snapshot arrives every 2s — within the 5s timeout — so the watchdog never fires.
    for (let elapsed = 2_000; elapsed <= 12_000; elapsed += 2_000) {
      setClock(1_000 + elapsed);
      vi.advanceTimersByTime(2_000);
      socket.receiveSnapshot({ t: 'snapshot', tick: elapsed, players: [], creatures: [], hearts: [] });
    }
    expect(client.state).toBe('online');
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

  it('served_elsewhere fast-retries at a fixed interval (not the growing backoff) until a holder welcomes', () => {
    const { client, states } = makeClient();
    client.connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].receive(welcome);

    // A multi-server LB routed us to an instance that does NOT hold this room.
    MockWebSocket.instances[0].receive({ t: 'error', code: 'served_elsewhere', msg: 'busy elsewhere' });
    expect(client.state).toBe('served_elsewhere');

    // It retries on the FIXED relocate interval (600ms) — not the 500ms→1000ms reconnect backoff.
    MockWebSocket.instances[0].serverClose();
    expect(client.state).toBe('served_elsewhere'); // stays on the friendly relocating overlay, no flip to reconnecting
    vi.advanceTimersByTime(599);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Still a non-holder: the SAME fixed 600ms again (no exponential growth).
    MockWebSocket.instances[1].open();
    MockWebSocket.instances[1].receive({ t: 'error', code: 'served_elsewhere', msg: 'busy elsewhere' });
    MockWebSocket.instances[1].serverClose();
    vi.advanceTimersByTime(599);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Landed on the holder: Welcome → online, the relocate flag is cleared.
    MockWebSocket.instances[2].open();
    MockWebSocket.instances[2].receive(welcome);
    expect(client.state).toBe('online');
    expect(states).toEqual(['connecting', 'online', 'served_elsewhere', 'online']);
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

  it('ping/pong replies with pong and updates ping', async () => {
    const { client, setClock } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    setClock(1_000);
    socket.receive({ t: 'ping', nonce: 42 });
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'pong', nonce: 42 }));

    setClock(1_080);
    socket.receive({ t: 'ping', nonce: 43 });
    expect(client.ping).toBe(80);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'pong', nonce: 43 }));
  });

  it('sendMove and sendChat serialize the right JSON', async () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    client.sendMove(1, 2, 3, 0.5, -0.2);
    client.sendChat('hello');
    expect(socket.sent.at(-2)).toEqual(frameOf({ t: 'move', x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2 }));
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'chat', text: 'hello' }));
  });

  it('sendHit serializes the attacked creature id', async () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    client.sendHit(7);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'hit', id: 7 }));
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

  it('serializes admin reject and unban messages', async () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    client.sendAdminReject('acc1');
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_reject', account_id: 'acc1' }));
    client.sendAdminBanPending('ip:1.2.3.4');
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_ban_pending', account_id: 'ip:1.2.3.4' }));
    client.sendAdminUnban('1.2.3.4');
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_unban', ip: '1.2.3.4' }));
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

  it('serializes admin approval toggle and approve messages', async () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    client.sendAdminSetApproval(true);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_set_approval', on: true }));
    client.sendAdminApprove('acc1');
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_approve', account_id: 'acc1' }));
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

  it('routes inventory to onInventory and serializes sendAdminSetInfinite', async () => {
    const inventories: unknown[] = [];
    const { client } = makeClient({ handlers: { onInventory: (m) => inventories.push(m) } });
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    socket.receive({ t: 'inventory', items: [{ id: 3, count: 2 }], infinite: false });
    expect(inventories).toEqual([{ t: 'inventory', items: [{ id: 3, count: 2 }], infinite: false }]);

    client.sendAdminSetInfinite(true);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_set_infinite', on: true }));
  });

  it('sendAdminSetPeace and sendAdminSetStructure serialize the right JSON', async () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    client.sendAdminSetPeace(true);
    client.sendAdminSetStructure('cola', false);
    expect(socket.sent.at(-2)).toEqual(frameOf({ t: 'admin_set_peace', on: true }));
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_set_structure', kind: 'cola', allowed: false }));
  });

  it('serializes pvp/chat/kick/ban admin and attack_player messages', async () => {
    const { client } = makeClient();
    client.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await flushWasm();
    socket.receive(welcome);

    client.sendAdminSetPvp(true);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_set_pvp', on: true }));
    client.sendAdminSetChat(false);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_set_chat', on: false }));
    client.sendAdminKick(3);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_kick', id: 3 }));
    client.sendAdminBan(4);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_ban', id: 4 }));
    client.sendAttackPlayer(5);
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'attack_player', id: 5 }));
    client.sendAdminResetWorld();
    expect(socket.sent.at(-1)).toEqual(frameOf({ t: 'admin_reset_world' }));
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
