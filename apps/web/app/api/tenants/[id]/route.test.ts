import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/api', () => ({
  getTenant: vi.fn(),
}));

import { GET } from './route';
import { getTenant } from '../../../../lib/api';

const getTenantMock = vi.mocked(getTenant);

afterEach(() => vi.clearAllMocks());

describe('GET /api/tenants/[id]', () => {
  it('returns the tenant from the api proxy', async () => {
    const tenant = { id: 'teo', name: 'Teocraft' } as Awaited<ReturnType<typeof getTenant>>;
    getTenantMock.mockResolvedValue(tenant);

    const res = await GET(new Request('http://x/api/tenants/teo'), { params: { id: 'teo' } });

    expect(getTenantMock).toHaveBeenCalledWith('teo');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'teo' });
    // no-store so a shared/edge cache never pins a stale branding shape (e.g. the old fields without `image`).
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 404 (still no-store) when the tenant is missing', async () => {
    getTenantMock.mockResolvedValue(null);

    const res = await GET(new Request('http://x/api/tenants/nope'), { params: { id: 'nope' } });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
