import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActions } from './actions';
import { createEngineState } from './engine-state';
import { BlockInventory } from './inventory';
import { MAX_HEARTS } from './constants';
import { Vec3 } from './vec3';
import type { GameRuntime } from './runtime';

const store = new Map<string, string>();
const BEST_KEY = 'bl-best';

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function makeRuntime(): GameRuntime {
  const state = createEngineState({ spawn: new Vec3(2, 3, 4) });
  const inventory = new BlockInventory();
  const runtime = {
    state,
    inventory,
    bestKey: BEST_KEY,
    isTouch: false,
    blockedStructures: new Set<string>(),
    heartDrops: [{}],
    world: { reset: vi.fn() },
    poofRuntime: { clear: vi.fn() },
    heartDropRuntime: { clear: vi.fn() },
    chime: vi.fn(),
    updateChunks: vi.fn(),
    processMeshQueue: vi.fn(),
    savePos: vi.fn(),
    spawnPoint: () => new Vec3(2, 3, 4),
    el: () => ({ textContent: '' }) as HTMLElement,
    storedBest: () => 0,
    updateHotbarCounts: vi.fn(),
  } as unknown as GameRuntime;
  return runtime;
}

describe('resetLocalWorld', () => {
  it('wipes the local player progress on an offline reset', () => {
    const runtime = makeRuntime();
    createActions(runtime);
    const refreshStats = vi.spyOn(runtime, 'updateStats');
    const { player } = runtime.state;
    player.stars = 12;
    player.bag = 5;
    player.hearts = 1;
    runtime.inventory.bank(1);
    store.set(BEST_KEY, '99');

    runtime.resetLocalWorld();

    expect(player.stars).toBe(0);
    expect(player.bag).toBe(0);
    expect(player.hearts).toBe(MAX_HEARTS);
    expect(runtime.inventory.count(1)).toBe(0);
    expect(store.get(BEST_KEY)).toBeUndefined();
    expect(refreshStats).toHaveBeenCalled();
    expect(runtime.updateHotbarCounts).toHaveBeenCalled();
  });

  it('rebuilds the world and respawns the player', () => {
    const runtime = makeRuntime();
    createActions(runtime);
    runtime.state.player.pos.set(40, 40, 40);

    runtime.resetLocalWorld();

    expect(runtime.world.reset).toHaveBeenCalled();
    expect(runtime.heartDrops).toHaveLength(0);
    expect(runtime.state.player.pos.equals(new Vec3(2, 3, 4))).toBe(true);
    expect(runtime.savePos).toHaveBeenCalled();
  });
});
