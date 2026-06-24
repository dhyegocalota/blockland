import { afterEach, describe, expect, it, vi } from 'vitest';
import { wasmOfflineEnabled, WASM_OFFLINE_STORAGE_KEY } from './wasm-offline-flag';

function stubWindow(search: string, storage: Record<string, string>): void {
  vi.stubGlobal('window', {
    location: { search },
    localStorage: { getItem: (key: string) => (key in storage ? storage[key] : null) },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('wasmOfflineEnabled', () => {
  it('is off by default (no query param, no storage) so the TS offline engine stays the default', () => {
    stubWindow('', {});
    expect(wasmOfflineEnabled()).toBe(false);
  });

  it('is on with ?wasmoffline=1', () => {
    stubWindow('?wasmoffline=1', {});
    expect(wasmOfflineEnabled()).toBe(true);
  });

  it('is on with the localStorage flag set to 1', () => {
    stubWindow('', { [WASM_OFFLINE_STORAGE_KEY]: '1' });
    expect(wasmOfflineEnabled()).toBe(true);
  });

  it('ignores other values (?wasmoffline=0, storage !== 1)', () => {
    stubWindow('?wasmoffline=0', { [WASM_OFFLINE_STORAGE_KEY]: '0' });
    expect(wasmOfflineEnabled()).toBe(false);
  });
});
