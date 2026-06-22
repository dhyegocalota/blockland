import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/admin-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../../lib/admin-server')>(
    '../../../../../lib/admin-server',
  );
  return { ...actual, fetchAccounts: vi.fn() };
});

import { GET } from './route';
import { fetchAccounts, AdminUpstreamError } from '../../../../../lib/admin-server';

const fetchAccountsMock = vi.mocked(fetchAccounts);
const ADMIN_KEY = 'dev-admin-secret';

function adminRequest(): Request {
  return new Request('http://x/api/admin/accounts/acme', { headers: { 'x-admin-key': ADMIN_KEY } });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/accounts/[tenant]', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await GET(new Request('http://x/api/admin/accounts/acme'), { params: { tenant: 'acme' } });
    expect(res.status).toBe(401);
    expect(fetchAccountsMock).not.toHaveBeenCalled();
  });

  it('rejects an empty tenant', async () => {
    const res = await GET(adminRequest(), { params: { tenant: '  ' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_tenant' });
    expect(fetchAccountsMock).not.toHaveBeenCalled();
  });

  it('proxies the accounts list when authorized', async () => {
    fetchAccountsMock.mockResolvedValue([{ name: 'Ana', admin: true }]);
    const res = await GET(adminRequest(), { params: { tenant: 'acme' } });
    expect(fetchAccountsMock).toHaveBeenCalledWith('acme');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'Ana', admin: true }]);
  });

  it('maps an upstream failure to a generic 502', async () => {
    fetchAccountsMock.mockRejectedValue(new AdminUpstreamError(503));
    const res = await GET(adminRequest(), { params: { tenant: 'acme' } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });
});
