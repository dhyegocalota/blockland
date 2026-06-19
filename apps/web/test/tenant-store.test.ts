import { beforeAll, describe, expect, it } from 'vitest';
import type { Tenant } from '../lib/builtins';

let store: typeof import('../lib/tenant-store');

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  store = await import('../lib/tenant-store');
});

describe('tenant-store', () => {
  it('seeds the built-in tenants on first access', async () => {
    const tenants = await store.listTenants();
    const ids = tenants.map((t) => t.id);
    expect(ids).toContain('teo');
    expect(ids).toContain('demo');
  });

  it('reads a seeded tenant by id', async () => {
    const teo = await store.getTenant('teo');
    expect(teo).not.toBeNull();
    expect(teo?.name).toBe('Teocraft');
  });

  it('returns null for an unknown tenant', async () => {
    expect(await store.getTenant('nope')).toBeNull();
  });

  it('upserts, reads back, and deletes a tenant', async () => {
    const draft: Tenant = {
      id: 'acme',
      name: 'Acme',
      hero: 'Wile',
      titleA: 'AC',
      titleB: 'ME',
      tagline: 'Beep beep',
      primary: '#ff0000',
      avatar: '/tenants/acme/avatar.png',
      faceTexture: '/tenants/acme/face.png',
      faceBlockName: 'Me!',
    };

    const saved = await store.upsertTenant(draft);
    expect(saved).toMatchObject(draft);

    const fetched = await store.getTenant('acme');
    expect(fetched).toMatchObject(draft);

    await store.deleteTenant('acme');
    expect(await store.getTenant('acme')).toBeNull();
  });
});
