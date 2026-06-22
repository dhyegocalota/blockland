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
    saveSession({ tenant: 'acme', name: 'Ann', claim: 'cl', is_admin: true, is_moderator: false });
    expect(loadSession()).toEqual({ tenant: 'acme', name: 'Ann', claim: 'cl', is_admin: true, is_moderator: false });
  });

  it('defaults is_admin to false for legacy sessions without the flag', () => {
    store.set(SESSION_KEY, '{"tenant":"acme","name":"Ann","claim":"cl"}');
    expect(loadSession()).toEqual({ tenant: 'acme', name: 'Ann', claim: 'cl', is_admin: false, is_moderator: false });
  });

  it('returns null for missing or malformed data', () => {
    expect(loadSession()).toBeNull();
    store.set(SESSION_KEY, 'not json');
    expect(loadSession()).toBeNull();
    store.set(SESSION_KEY, '{"tenant":"acme","name":"Ann"}');
    expect(loadSession()).toBeNull();
  });

  it('clears the session', () => {
    saveSession({ tenant: 'acme', name: 'Ann', claim: 'cl', is_admin: false, is_moderator: false });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('resolveClaim only returns the claim for the matching tenant + name', () => {
    saveSession({ tenant: 'acme', name: 'Ann', claim: 'cl', is_admin: false, is_moderator: false });
    expect(resolveClaim('acme', 'Ann')).toBe('cl');
    expect(resolveClaim('demo', 'Ann')).toBe('');
    expect(resolveClaim('acme', 'Bob')).toBe('');
  });

  it('resolveClaim returns empty when no session exists', () => {
    expect(resolveClaim('acme', 'Ann')).toBe('');
  });
});
