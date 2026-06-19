import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTenant, tenantIdFromLocation } from './tenants';
import { DEFAULT_TENANT } from './builtins';

function stubLocation({ hostname, search }: { hostname: string; search: string }) {
  globalThis.window = { location: { hostname, search } } as unknown as Window & typeof globalThis;
}

type StubResponse = { ok: boolean; json?: () => Promise<unknown> };

function stubFetch(response: StubResponse) {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

function stubFetchByUrl(routes: { api: StubResponse; bundle: StubResponse }) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/tenant.json')) return Promise.resolve(routes.bundle);
    return Promise.resolve(routes.api);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('tenantIdFromLocation', () => {
  it('prefers the ?tenant override', () => {
    stubLocation({ hostname: 'teo.blocklandia.app', search: '?tenant=Demo' });
    expect(tenantIdFromLocation()).toBe('demo');
  });

  it('resolves a localhost subdomain', () => {
    stubLocation({ hostname: 'teo.localhost', search: '' });
    expect(tenantIdFromLocation()).toBe('teo');
  });

  it('resolves an app subdomain', () => {
    stubLocation({ hostname: 'teo.blocklandia.app', search: '' });
    expect(tenantIdFromLocation()).toBe('teo');
  });

  it('falls back to the default tenant on bare localhost', () => {
    stubLocation({ hostname: 'localhost', search: '' });
    expect(tenantIdFromLocation()).toBe(DEFAULT_TENANT);
  });

  it('falls back to the default tenant on vercel.app previews', () => {
    stubLocation({ hostname: 'my-app.vercel.app', search: '' });
    expect(tenantIdFromLocation()).toBe(DEFAULT_TENANT);
  });
});

describe('resolveTenant', () => {
  it('returns the tenant from the data API as online', async () => {
    stubLocation({ hostname: 'teo.localhost', search: '' });
    const tenant = { id: 'teo', name: 'Teocraft' };
    stubFetch({ ok: true, json: () => Promise.resolve(tenant) });
    await expect(resolveTenant()).resolves.toEqual({ tenant, offline: false });
  });

  it('falls back to the bundled tenant.json as offline when the API fails', async () => {
    stubLocation({ hostname: 'teo.localhost', search: '' });
    const tenant = { id: 'teo', name: 'Teocraft' };
    stubFetchByUrl({ api: { ok: false }, bundle: { ok: true, json: () => Promise.resolve(tenant) } });
    await expect(resolveTenant()).resolves.toEqual({ tenant, offline: true });
  });

  it('throws when both the API and the bundled tenant.json are missing', async () => {
    stubLocation({ hostname: 'ghost.localhost', search: '' });
    stubFetchByUrl({ api: { ok: false }, bundle: { ok: false } });
    await expect(resolveTenant()).rejects.toThrow('tenant_unavailable:ghost');
  });
});
