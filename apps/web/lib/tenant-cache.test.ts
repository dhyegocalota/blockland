// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { connectivityAfterFetch, loadCachedTenant, saveCachedTenant } from './tenant-cache';
import type { Tenant } from './builtins';

const TENANT: Tenant = {
  id: 'acme',
  name: 'Acme World',
  image: '/a.png',
  playtime_limit_min: 0,
  playtime_window_h: 0,
  online_allowed: true,
  offline_allowed: true,
};

afterEach(() => window.localStorage.clear());

describe('tenant cache', () => {
  it('round-trips a tenant by id and misses cleanly', () => {
    expect(loadCachedTenant('acme')).toBeNull();
    saveCachedTenant(TENANT);
    expect(loadCachedTenant('acme')).toEqual(TENANT);
    expect(loadCachedTenant('other')).toBeNull();
    expect(loadCachedTenant(null)).toBeNull();
  });

  it('returns null for corrupt cached json instead of throwing', () => {
    window.localStorage.setItem('bl-tenant:acme', '{not json');
    expect(loadCachedTenant('acme')).toBeNull();
  });
});

describe('connectivityAfterFetch', () => {
  it('is online when the fetch succeeded', () => {
    expect(connectivityAfterFetch({ fetched: true, navigatorOnline: true })).toBe('online');
    expect(connectivityAfterFetch({ fetched: true, navigatorOnline: false })).toBe('online');
  });

  it('distinguishes a down server from a missing network when the fetch failed', () => {
    expect(connectivityAfterFetch({ fetched: false, navigatorOnline: true })).toBe('server_down');
    expect(connectivityAfterFetch({ fetched: false, navigatorOnline: false })).toBe('no_internet');
  });
});
