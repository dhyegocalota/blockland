import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoopOptions } from '../../coop';

// startCoop picks the coop source: the WebSocket online path, or — by DEFAULT for single-player — the
// offline-via-core path (the WASM game-core). We mock the coop factory + the wasm net so the routing
// decision is observable without a socket or the real wasm.
const mocks = vi.hoisted(() => ({
  createCoop: vi.fn((_opts: CoopOptions) => ({}) as never),
  createWasmCoreNet: vi.fn(),
}));
const { createCoop, createWasmCoreNet } = mocks;

vi.mock('../../coop', async (importActual) => {
  const actual = await importActual<typeof import('../../coop')>();
  return { ...actual, createCoop: mocks.createCoop };
});
vi.mock('./wasm-core-source', async (importActual) => {
  const actual = await importActual<typeof import('./wasm-core-source')>();
  return { ...actual, createWasmCoreNet: mocks.createWasmCoreNet };
});

import { createCoopWiring } from './coop-wiring';
import type { GameRuntime } from '../runtime';

function makeRuntime(opts: { serverUrl?: string; offline: boolean }) {
  const runtime = {
    state: { player: { pos: { set: () => {} }, vel: { set: () => {} } } },
    brand: { id: 'acme', name: 'Acme', image: 'x.png' },
    coop: null,
    coopView: {},
    serverUrl: opts.serverUrl,
    bridge: {
      hud: { onScore: vi.fn(), onRole: vi.fn() },
      resolveName: () => 'Ana',
      resolveAppearance: () => ({ skin: 'a', shirt: 'b', hair: 'c' }),
      resolveClaim: () => 'claim',
      resolveOffline: () => opts.offline,
    },
    recordServerScore: vi.fn(),
    updateStats: vi.fn(),
  } as unknown as GameRuntime;
  createCoopWiring(runtime);
  return { runtime };
}

beforeEach(() => { createCoop.mockClear(); createWasmCoreNet.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

describe('startCoop source selection', () => {
  it('chosen single-player runs offline-via-core: createCoop with the wasm netFactory and an empty url', () => {
    const { runtime } = makeRuntime({ serverUrl: 'ws://x', offline: true });
    runtime.startCoop();
    expect(createCoop).toHaveBeenCalledTimes(1);
    const options = createCoop.mock.calls[0][0];
    expect(options.url).toBe('');
    options.netFactory?.({ handlers: {} } as never);
    expect(createWasmCoreNet).toHaveBeenCalledTimes(1);
  });

  it('no server url also runs offline-via-core (single-player is the default offline engine)', () => {
    const { runtime } = makeRuntime({ serverUrl: undefined, offline: false });
    runtime.startCoop();
    expect(createCoop).toHaveBeenCalledTimes(1);
    expect(createCoop.mock.calls[0][0].url).toBe('');
  });

  it('ONLINE (server url + not offline) uses the WebSocket path, not the core', () => {
    const { runtime } = makeRuntime({ serverUrl: 'ws://x', offline: false });
    runtime.startCoop();
    expect(createCoop).toHaveBeenCalledTimes(1);
    const options = createCoop.mock.calls[0][0];
    expect(options.url).toBe('ws://x');
    expect(options.netFactory).toBeUndefined();
  });
});
