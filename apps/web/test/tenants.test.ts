import { afterEach, describe, expect, it } from 'vitest';
import { tenantIdFromLocation } from '../lib/tenants';
import { DEFAULT_TENANT } from '../lib/builtins';

function stubLocation({ hostname, search }: { hostname: string; search: string }) {
  globalThis.window = { location: { hostname, search } } as unknown as Window & typeof globalThis;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
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
