import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAdmin } from './admin-auth';

const ADMIN_KEY = 'a-real-secret';

function requestWithKey(key: string | null): Request {
  const headers = new Headers();
  if (key !== null) headers.set('x-admin-key', key);
  return new Request('https://example.com/admin', { headers });
}

describe('isAdmin', () => {
  beforeEach(() => { process.env.ADMIN_KEY = ADMIN_KEY; });
  afterEach(() => { delete process.env.ADMIN_KEY; });

  it('fails closed when ADMIN_KEY is unset', () => {
    delete process.env.ADMIN_KEY;
    expect(isAdmin(requestWithKey(ADMIN_KEY))).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isAdmin(requestWithKey(null))).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(isAdmin(requestWithKey(''))).toBe(false);
  });

  it('rejects a wrong key', () => {
    expect(isAdmin(requestWithKey('nope'))).toBe(false);
  });

  it('accepts the matching key', () => {
    expect(isAdmin(requestWithKey(ADMIN_KEY))).toBe(true);
  });
});
