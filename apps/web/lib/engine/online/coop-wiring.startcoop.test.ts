import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoopOptions } from '../../coop';

// startCoop picks the coop source: the WebSocket online path, the TS offline engine, or — only behind the
// `?wasmoffline=1` flag — the offline-via-core path. We mock the coop factory + the flag + the wasm net so
// the routing decision is observable without a socket or the real wasm.
const mocks = vi.hoisted(() => ({
  createCoop: vi.fn((_opts: CoopOptions) => ({}) as never),
  createWasmCoreNet: vi.fn(),
  flagOn: false,
}));
const { createCoop, createWasmCoreNet } = mocks;

vi.mock('../../coop', async (importActual) => {
  const actual = await importActual<typeof import('../../coop')>();
  return { ...actual, createCoop: mocks.createCoop };
});
vi.mock('./wasm-offline-flag', () => ({ wasmOfflineEnabled: () => mocks.flagOn }));
vi.mock('./wasm-core-source', async (importActual) => {
  const actual = await importActual<typeof import('./wasm-core-source')>();
  return { ...actual, createWasmCoreNet: mocks.createWasmCoreNet };
});

import { createCoopWiring } from './coop-wiring';
import type { GameRuntime } from '../runtime';

function makeRuntime(opts: { serverUrl?: string; offline: boolean }) {
  const grantOfflineAdmin = vi.fn();
  const enterOfflineMode = vi.fn();
  const runtime = {
    state: { player: { pos: { set: () => {} }, vel: { set: () => {} } } },
    brand: { id: 'acme', name: 'Acme', image: 'x.png' },
    coop: null,
    coopView: {},
    serverUrl: opts.serverUrl,
    grantOfflineAdmin,
    enterOfflineMode,
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
  return { runtime, grantOfflineAdmin, enterOfflineMode };
}

beforeEach(() => { createCoop.mockClear(); createWasmCoreNet.mockClear(); mocks.flagOn = false; });
afterEach(() => vi.unstubAllGlobals());

describe('startCoop source selection', () => {
  it('flag OFF + chosen single-player runs the TS offline engine (no createCoop)', () => {
    const { runtime, enterOfflineMode } = makeRuntime({ serverUrl: 'ws://x', offline: true });
    runtime.startCoop();
    expect(enterOfflineMode).toHaveBeenCalledTimes(1);
    expect(createCoop).not.toHaveBeenCalled();
  });

  it('flag OFF + no server url grants offline admin (TS offline), no createCoop', () => {
    const { runtime, grantOfflineAdmin } = makeRuntime({ serverUrl: undefined, offline: false });
    runtime.startCoop();
    expect(grantOfflineAdmin).toHaveBeenCalledTimes(1);
    expect(createCoop).not.toHaveBeenCalled();
  });

  it('flag ON + chosen single-player runs offline-via-core: createCoop with the wasm netFactory, not the TS engine', () => {
    mocks.flagOn = true;
    const { runtime, enterOfflineMode } = makeRuntime({ serverUrl: 'ws://x', offline: true });
    runtime.startCoop();
    expect(enterOfflineMode).not.toHaveBeenCalled();
    expect(createCoop).toHaveBeenCalledTimes(1);
    const options = createCoop.mock.calls[0][0];
    expect(options.url).toBe('');
    options.netFactory?.({ handlers: {} } as never);
    expect(createWasmCoreNet).toHaveBeenCalledTimes(1);
  });

  it('flag ON + no server url also runs offline-via-core', () => {
    mocks.flagOn = true;
    const { runtime, grantOfflineAdmin } = makeRuntime({ serverUrl: undefined, offline: false });
    runtime.startCoop();
    expect(grantOfflineAdmin).not.toHaveBeenCalled();
    expect(createCoop).toHaveBeenCalledTimes(1);
  });

  it('flag ON but ONLINE (server url + not offline) still uses the WebSocket path, not the core', () => {
    mocks.flagOn = true;
    const { runtime } = makeRuntime({ serverUrl: 'ws://x', offline: false });
    runtime.startCoop();
    expect(createCoop).toHaveBeenCalledTimes(1);
    const options = createCoop.mock.calls[0][0];
    expect(options.url).toBe('ws://x');
    expect(options.netFactory).toBeUndefined();
  });
});
