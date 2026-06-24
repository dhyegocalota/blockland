import { describe, expect, it, vi } from 'vitest';
import { createCoopWiring } from './coop-wiring';
import { AIR } from '../constants';
import type { GameRuntime } from '../runtime';

function makeEditRuntime() {
  const spawnPoof = vi.fn();
  const runtime = {
    state: { chatEnabled: true, player: { pos: { x: 0, y: 20, z: 0 }, vel: { set: () => {} }, bag: 0 } },
    brand: { id: 'acme' },
    coop: {},
    bridge: { hud: {}, resolveName: () => 'A', bind: vi.fn() },
    inBounds: () => true,
    getVoxel: () => 3, // stone (#7f7f7f)
    setVoxel: vi.fn(),
    remeshRegion: vi.fn(),
    spawnPoof,
    isSolid: () => false,
    inventory: { bank: vi.fn() },
    updateHotbarCounts: vi.fn(),
    updateStats: vi.fn(),
  } as unknown as GameRuntime;
  createCoopWiring(runtime);
  return { runtime, spawnPoof };
}

describe('createCoopWiring applyRemoteEdit', () => {
  it("puffs the broken block's colour when ANOTHER player breaks it, so the splash shows for everyone", () => {
    const { runtime, spawnPoof } = makeEditRuntime();
    runtime.applyRemoteEdit({ x: 5, y: 6, z: 7, id: AIR, mine: false });
    expect(spawnPoof).toHaveBeenCalledTimes(1);
    expect(spawnPoof.mock.calls[0][1]).toBe('#7f7f7f');
  });

  it('does not double-puff my own break (the local dig already puffed it)', () => {
    const { runtime, spawnPoof } = makeEditRuntime();
    runtime.applyRemoteEdit({ x: 5, y: 6, z: 7, id: AIR, mine: true });
    expect(spawnPoof).not.toHaveBeenCalled();
  });

  it('does not puff a remote place (only breaks splash)', () => {
    const { runtime, spawnPoof } = makeEditRuntime();
    runtime.applyRemoteEdit({ x: 5, y: 6, z: 7, id: 3, mine: false });
    expect(spawnPoof).not.toHaveBeenCalled();
  });
});

describe('createCoopWiring applyRemoteEditBatch (streamed chunk load)', () => {
  it("applies every cell of a streamed chunk and remeshes the region it spans, so a moved-into chunk's built structures appear", () => {
    const { runtime } = makeEditRuntime();
    // A chunk arrives incrementally as the player moves into it (the server streams it as one EditBatch).
    runtime.applyRemoteEditBatch([
      { x: 130, y: 8, z: 20, id: 3 },
      { x: 140, y: 9, z: 35, id: 8 },
    ]);
    expect(runtime.setVoxel).toHaveBeenCalledWith(130, 8, 20, 3);
    expect(runtime.setVoxel).toHaveBeenCalledWith(140, 9, 35, 8);
    // The remesh covers the cells' x/z bounds with a one-block margin (so neighbouring faces re-light).
    expect(runtime.remeshRegion).toHaveBeenCalledWith(129, 141, 19, 36);
  });

  it('ignores an empty streamed chunk (a chunk nobody built in carries no cells)', () => {
    const { runtime } = makeEditRuntime();
    runtime.applyRemoteEditBatch([]);
    expect(runtime.setVoxel).not.toHaveBeenCalled();
    expect(runtime.remeshRegion).not.toHaveBeenCalled();
  });
});

function makeRuntime({ online, chatEnabled }: { online: boolean; chatEnabled: boolean }) {
  const onChat = vi.fn();
  const bind = vi.fn();
  const coopSendChat = vi.fn();
  const runtime = {
    state: { chatEnabled, player: { pos: {}, vel: { set: () => {} } } },
    brand: { id: 'acme' },
    coop: online ? { sendChat: coopSendChat } : null,
    bridge: { hud: { onChat }, resolveName: () => 'Alice', bind },
  } as unknown as GameRuntime;
  createCoopWiring(runtime);
  runtime.bindApi();
  return { api: bind.mock.calls[0][0], onChat, coopSendChat };
}

describe('createCoopWiring sendChat', () => {
  it('offline echoes the message locally under the player name', () => {
    const { api, onChat } = makeRuntime({ online: false, chatEnabled: true });
    api.sendChat('oi');
    expect(onChat).toHaveBeenCalledWith('Alice', 'oi');
  });

  it('online forwards to the server and does not echo locally', () => {
    const { api, onChat, coopSendChat } = makeRuntime({ online: true, chatEnabled: true });
    api.sendChat('oi');
    expect(coopSendChat).toHaveBeenCalledWith('oi');
    expect(onChat).not.toHaveBeenCalled();
  });

  it('drops the message when room chat is disabled', () => {
    const { api, onChat, coopSendChat } = makeRuntime({ online: false, chatEnabled: false });
    api.sendChat('oi');
    expect(onChat).not.toHaveBeenCalled();
    expect(coopSendChat).not.toHaveBeenCalled();
  });
});
