import { describe, expect, it, vi } from 'vitest';
import { createWasmCoreNet, wasmOfflineConfig } from './wasm-core-source';
import { OutboundKind, type OutboundMessage, type WasmCore } from './wasm-core-loader';
import { encodeKeyframe } from '../../snapshot-codec';
import type { SnapshotMsg } from '../../net';
import type { NetHandlers } from '../../net';

// A fake WasmCore: records every input + tick, and hands back queued outbound messages on drain so a test
// can stage what the "server" produces. No real wasm — the driver logic is what's under test.
function makeFakeCore() {
  const inputs: { playerId: number; msg: Record<string, unknown> }[] = [];
  const outbound: OutboundMessage[] = [];
  let ticks = 0;
  const core = {
    add_local_player: vi.fn(() => 7),
    input: vi.fn((playerId: number, msg: string) => { inputs.push({ playerId, msg: JSON.parse(msg) }); }),
    tick: vi.fn(() => { ticks += 1; return true; }),
    drain_outbound: vi.fn(() => outbound.splice(0, outbound.length)),
    chunk_edits: vi.fn(() => new Int32Array()),
    world_blob: vi.fn(() => new Uint8Array()),
    free: vi.fn(),
  } as unknown as WasmCore;
  const json = (value: Record<string, unknown>): void => {
    outbound.push({ kind: OutboundKind.Json, json: JSON.stringify(value), binary: new Uint8Array() } as OutboundMessage);
  };
  const binary = (bytes: Uint8Array): void => {
    outbound.push({ kind: OutboundKind.Binary, json: '', binary: bytes } as OutboundMessage);
  };
  return { core, inputs, json, binary, ticks: () => ticks };
}

// Drives connect() to completion (the createCore promise) and exposes a manual step pump.
function makeDriver(handlers: NetHandlers) {
  const fake = makeFakeCore();
  let pendingStep: (() => void) | null = null;
  const net = createWasmCoreNet({
    handlers,
    name: 'Ana',
    look: { skin: 'a', shirt: 'b', hair: 'c' },
    init: { seed: 1, config: '{}', debug: false },
    createCore: () => Promise.resolve(fake.core),
    schedule: (step) => { pendingStep = step; return () => { pendingStep = null; }; },
    now: () => 1000,
    wall: () => 2000,
  });
  const step = (): void => { const s = pendingStep; pendingStep = null; if (s) s(); };
  return { net, fake, step, hasPending: () => pendingStep !== null };
}

describe('createWasmCoreNet driver', () => {
  it('admits the local player as the only join on connect (no Join ClientMsg — the core adds the admin)', async () => {
    const { net, fake } = makeDriver({});
    net.connect();
    await Promise.resolve();
    expect(fake.core.add_local_player).toHaveBeenCalledWith('Ana', JSON.stringify({ skin: 'a', shirt: 'b', hair: 'c' }));
    expect(fake.inputs).toEqual([]);
  });

  it('feeds each send* as the matching ClientMsg into core.input for the local player', async () => {
    const { net, fake } = makeDriver({});
    net.connect();
    await Promise.resolve();
    net.sendMove(1, 2, 3, 0.5, -0.2);
    net.sendDig(4, 5, 6);
    net.sendEdit('place', 7, 8, 9, 3);
    net.sendChat('hi');
    net.sendHit(11);
    net.sendAdminSetPeace(true);
    net.sendAdminSetStructure('tower', false);
    expect(fake.inputs.map((i) => i.msg)).toEqual([
      { t: 'move', x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2 },
      { t: 'dig', x: 4, y: 5, z: 6 },
      { t: 'edit', op: 'place', x: 7, y: 8, z: 9, id: 3 },
      { t: 'chat', text: 'hi' },
      { t: 'hit', id: 11 },
      { t: 'admin_set_peace', on: true },
      { t: 'admin_set_structure', kind: 'tower', allowed: false },
    ]);
    expect(fake.inputs.every((i) => i.playerId === 7)).toBe(true);
  });

  it('ticks the core and drains its outbound each scheduled step', async () => {
    const { net, fake, step } = makeDriver({});
    net.connect();
    await Promise.resolve();
    expect(fake.ticks()).toBe(0);
    step();
    step();
    expect(fake.ticks()).toBe(2);
    expect(fake.core.drain_outbound).toHaveBeenCalledTimes(2);
  });

  it('routes each JSON ServerMsg kind to the matching handler and flips to online on Welcome', async () => {
    const onState = vi.fn();
    const onWelcome = vi.fn();
    const onRoster = vi.fn();
    const onEdit = vi.fn();
    const onRoomState = vi.fn();
    const onChat = vi.fn();
    const onInventory = vi.fn();
    const onError = vi.fn();
    const { net, fake, step } = makeDriver({ onState, onWelcome, onRoster, onEdit, onRoomState, onChat, onInventory, onError });
    net.connect();
    await Promise.resolve();
    expect(onState).toHaveBeenCalledWith('connecting');

    fake.json({ t: 'welcome', you: 7, world: 'main', admin: true, moderator: false });
    fake.json({ t: 'roster', players: [] });
    fake.json({ t: 'room_state', peace: true });
    fake.json({ t: 'edit', x: 1, y: 2, z: 3, id: 0, by: 7 });
    fake.json({ t: 'chat', from: 7, name: 'Ana', text: 'yo' });
    fake.json({ t: 'inventory', items: [], infinite: true });
    fake.json({ t: 'error', code: 'nope', msg: 'because' });
    step();

    expect(onWelcome).toHaveBeenCalledWith(expect.objectContaining({ t: 'welcome', you: 7, admin: true }));
    expect(onRoster).toHaveBeenCalledWith(expect.objectContaining({ t: 'roster' }));
    expect(onRoomState).toHaveBeenCalledWith(expect.objectContaining({ t: 'room_state', peace: true }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ t: 'edit', x: 1, by: 7 }));
    expect(onChat).toHaveBeenCalledWith(expect.objectContaining({ t: 'chat', text: 'yo' }));
    expect(onInventory).toHaveBeenCalledWith(expect.objectContaining({ t: 'inventory', infinite: true }));
    expect(onError).toHaveBeenCalledWith('nope', 'because');
    expect(onState).toHaveBeenCalledWith('online');
  });

  it('routes a binary outbound frame through onSnapshot (the snapshot decoder), not the JSON switch', async () => {
    const onSnapshot = vi.fn();
    const onWelcome = vi.fn();
    const { net, fake, step } = makeDriver({ onSnapshot, onWelcome });
    net.connect();
    await Promise.resolve();
    const snapshot: SnapshotMsg = { t: 'snapshot', tick: 5, players: [{ id: 7, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, ping_ms: 0, score: 0, hp: 10 }], creatures: [], hearts: [] };
    fake.binary(encodeKeyframe(snapshot));
    step();
    expect(onWelcome).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0][0]).toMatchObject({ t: 'snapshot', tick: 5 });
  });

  it('stops ticking + frees the core on close and reports offline', async () => {
    const onState = vi.fn();
    const { net, fake, step, hasPending } = makeDriver({ onState });
    net.connect();
    await Promise.resolve();
    expect(hasPending()).toBe(true);
    net.close();
    expect(fake.core.free).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith('offline');
    expect(hasPending()).toBe(false);
    step();
    expect(fake.ticks()).toBe(0);
  });

  it('reports state offline + surfaces an error when the core fails to init', async () => {
    const onState = vi.fn();
    const onError = vi.fn();
    const net = createWasmCoreNet({
      handlers: { onState, onError },
      name: 'Ana',
      look: { skin: 'a', shirt: 'b', hair: 'c' },
      init: { seed: 1, config: '{}', debug: false },
      createCore: () => Promise.reject(new Error('boom')),
      schedule: (step) => { void step; return () => {}; },
    });
    net.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('wasm_init', expect.stringContaining('boom'));
    expect(onState).toHaveBeenLastCalledWith('offline');
  });
});

describe('wasmOfflineConfig', () => {
  it('builds the JSON config with branding + the fixed global room limits', () => {
    const config = wasmOfflineConfig({ tenant: 'acme', world: 'main', brand: { name: 'Acme', image: 'x.png' } });
    expect(config).toMatchObject({
      tenant: 'acme', world: 'main', brand_name: 'Acme', brand_image: 'x.png',
      tick_hz: 20, max_players: 10, idle_secs: 45, edit_reach: 9,
      edit_per_sec: 25, chat_per_sec: 2,
    });
  });

  // Movement parity: offline is a single local player with no cheating to prevent, so the core's move
  // anti-cheat must never rubber-band it. The speed cap + per-move budget are raised far above any
  // single-tick move (the world spans 163840 units) so `dist <= max_speed * dt` always holds and the move
  // is taken whole, exactly like the TS offline engine moved the player directly. Online is untouched.
  it('lifts the move clamp offline (speed cap + move budget above any real move) so it never rubber-bands', () => {
    const config = wasmOfflineConfig({ tenant: 'acme', world: 'main', brand: { name: 'Acme', image: 'x.png' } });
    expect(config.max_speed).toBeGreaterThan(163840);
    expect(config.move_per_sec).toBeGreaterThan(163840);
  });
});
