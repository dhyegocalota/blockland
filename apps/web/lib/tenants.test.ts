import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTenant, tenantIdFromLocation } from './tenants';
import { DEFAULT_TENANT } from './builtins';

function stubLocation({ hostname, search }: { hostname: string; search: string }) {
  globalThis.window = { location: { hostname, search } } as unknown as Window & typeof globalThis;
}

function stubFetch(response: { ok: boolean; json?: () => Promise<unknown> }) {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
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
  it('returns the tenant from the data API', async () => {
    stubLocation({ hostname: 'teo.localhost', search: '' });
    const tenant = { id: 'teo', name: 'Teocraft' };
    stubFetch({ ok: true, json: () => Promise.resolve(tenant) });
    await expect(resolveTenant()).resolves.toEqual(tenant);
  });

  it('throws when the tenant cannot be loaded (no silent fallback)', async () => {
    stubLocation({ hostname: 'ghost.localhost', search: '' });
    stubFetch({ ok: false });
    await expect(resolveTenant()).rejects.toThrow('tenant_unavailable:ghost');
  });
});
