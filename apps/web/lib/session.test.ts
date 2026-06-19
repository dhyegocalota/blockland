import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_KEY, clearSession, loadSession, resolveClaim, saveSession } from './session';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  viStubLocalStorage();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function viStubLocalStorage(): void {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

describe('session', () => {
  it('round-trips a saved session', () => {
    saveSession({ tenant: 'teo', name: 'Ann', claim: 'cl' });
    expect(loadSession()).toEqual({ tenant: 'teo', name: 'Ann', claim: 'cl' });
    expect(store.get(SESSION_KEY)).toBe('{"tenant":"teo","name":"Ann","claim":"cl"}');
  });

  it('returns null for missing or malformed data', () => {
    expect(loadSession()).toBeNull();
    store.set(SESSION_KEY, 'not json');
    expect(loadSession()).toBeNull();
    store.set(SESSION_KEY, '{"tenant":"teo","name":"Ann"}');
    expect(loadSession()).toBeNull();
  });

  it('clears the session', () => {
    saveSession({ tenant: 'teo', name: 'Ann', claim: 'cl' });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('resolveClaim only returns the claim for the matching tenant + name', () => {
    saveSession({ tenant: 'teo', name: 'Ann', claim: 'cl' });
    expect(resolveClaim('teo', 'Ann')).toBe('cl');
    expect(resolveClaim('demo', 'Ann')).toBe('');
    expect(resolveClaim('teo', 'Bob')).toBe('');
  });

  it('resolveClaim returns empty when no session exists', () => {
    expect(resolveClaim('teo', 'Ann')).toBe('');
  });
});
