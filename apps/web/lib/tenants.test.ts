import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTenant, rootDomainOf, tenantIdFromLocation, tenantSubdomain } from './tenants';

const PROD_ROOT = 'blockland.dhyegocalota.com.br';

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
  vi.unstubAllEnvs();
});

describe('tenantSubdomain', () => {
  it('is null on the production app root (admin lives here)', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    stubLocation({ hostname: PROD_ROOT, search: '' });
    expect(tenantSubdomain()).toBeNull();
  });

  it('extracts the tenant from a production subdomain', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    stubLocation({ hostname: `acme.${PROD_ROOT}`, search: '' });
    expect(tenantSubdomain()).toBe('acme');
  });

  it('is null on bare localhost and a tenant on a localhost subdomain', () => {
    stubLocation({ hostname: 'localhost', search: '' });
    expect(tenantSubdomain()).toBeNull();
    stubLocation({ hostname: 'acme.localhost', search: '' });
    expect(tenantSubdomain()).toBe('acme');
  });
});

describe('rootDomainOf', () => {
  it('returns the production root host unchanged', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rootDomainOf(PROD_ROOT)).toBe(PROD_ROOT);
  });

  it('drops a production tenant label back to the root', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rootDomainOf(`acme.${PROD_ROOT}`)).toBe(PROD_ROOT);
  });

  it('drops a localhost tenant label to bare localhost', () => {
    expect(rootDomainOf('acme.localhost')).toBe('localhost');
    expect(rootDomainOf('localhost')).toBe('localhost');
  });
});

describe('tenantIdFromLocation', () => {
  it('prefers the ?tenant override', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    stubLocation({ hostname: PROD_ROOT, search: '?tenant=Demo' });
    expect(tenantIdFromLocation()).toBe('demo');
  });

  it('resolves a localhost subdomain', () => {
    stubLocation({ hostname: 'acme.localhost', search: '' });
    expect(tenantIdFromLocation()).toBe('acme');
  });

  it('resolves a production subdomain', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    stubLocation({ hostname: `acme.${PROD_ROOT}`, search: '' });
    expect(tenantIdFromLocation()).toBe('acme');
  });

  it('is null on the production app root (no tenant resolved)', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    stubLocation({ hostname: PROD_ROOT, search: '' });
    expect(tenantIdFromLocation()).toBeNull();
  });

  it('is null on bare localhost (no tenant resolved)', () => {
    stubLocation({ hostname: 'localhost', search: '' });
    expect(tenantIdFromLocation()).toBeNull();
  });
});

describe('resolveTenant', () => {
  it('returns the tenant from the data API as online', async () => {
    stubLocation({ hostname: 'acme.localhost', search: '' });
    const tenant = { id: 'acme', name: 'Acme' };
    stubFetch({ ok: true, json: () => Promise.resolve(tenant) });
    await expect(resolveTenant()).resolves.toEqual({ tenant, offline: false });
  });

  it('falls back to the bundled tenant.json as offline when the API fails', async () => {
    stubLocation({ hostname: 'acme.localhost', search: '' });
    const tenant = { id: 'acme', name: 'Acme' };
    stubFetchByUrl({ api: { ok: false }, bundle: { ok: true, json: () => Promise.resolve(tenant) } });
    await expect(resolveTenant()).resolves.toEqual({ tenant, offline: true });
  });

  it('throws when both the API and the bundled tenant.json are missing', async () => {
    stubLocation({ hostname: 'ghost.localhost', search: '' });
    stubFetchByUrl({ api: { ok: false }, bundle: { ok: false } });
    await expect(resolveTenant()).rejects.toThrow('tenant_unavailable:ghost');
  });

  it('throws when no tenant resolves from the host or query', async () => {
    stubLocation({ hostname: 'localhost', search: '' });
    await expect(resolveTenant()).rejects.toThrow('tenant_unresolved');
  });
});
