import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/rust-api', () => ({
  listTenants: vi.fn(),
  upsertTenant: vi.fn(),
}));

import { GET, POST } from './route';
import { listTenants, upsertTenant } from '../../../../lib/rust-api';
import type { Tenant } from '../../../../lib/builtins';

const listTenantsMock = vi.mocked(listTenants);
const upsertTenantMock = vi.mocked(upsertTenant);

const ADMIN_KEY = 'dev-admin-secret';

const VALID_TENANT: Tenant = {
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

function adminRequest(init: RequestInit = {}): Request {
  return new Request('http://x/api/admin/tenants', {
    ...init,
    headers: { 'x-admin-key': ADMIN_KEY, ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/tenants', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await GET(new Request('http://x/api/admin/tenants'));
    expect(res.status).toBe(401);
    expect(listTenantsMock).not.toHaveBeenCalled();
  });

  it('lists tenants via the proxy when authorized', async () => {
    listTenantsMock.mockResolvedValue([VALID_TENANT]);
    const res = await GET(adminRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([VALID_TENANT]);
  });
});

describe('POST /api/admin/tenants', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await POST(
      new Request('http://x/api/admin/tenants', { method: 'POST', body: JSON.stringify(VALID_TENANT) }),
    );
    expect(res.status).toBe(401);
    expect(upsertTenantMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid id', async () => {
    const res = await POST(
      adminRequest({ method: 'POST', body: JSON.stringify({ ...VALID_TENANT, id: 'A' }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_id' });
  });

  it('rejects a missing field', async () => {
    const { name, ...withoutName } = VALID_TENANT;
    const res = await POST(adminRequest({ method: 'POST', body: JSON.stringify(withoutName) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'missing_field', field: 'name' });
  });

  it('upserts via the proxy when authorized and valid', async () => {
    upsertTenantMock.mockResolvedValue(VALID_TENANT);
    const res = await POST(adminRequest({ method: 'POST', body: JSON.stringify(VALID_TENANT) }));
    expect(upsertTenantMock).toHaveBeenCalledWith(VALID_TENANT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_TENANT);
  });
});
