import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/admin-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/admin-server')>(
    '../../../../lib/admin-server',
  );
  return { ...actual, fetchBans: vi.fn() };
});

import { GET } from './route';
import { fetchBans, AdminUpstreamError } from '../../../../lib/admin-server';

const fetchBansMock = vi.mocked(fetchBans);
const ADMIN_KEY = 'dev-admin-secret';

function adminRequest(): Request {
  return new Request('http://x/api/admin/bans', { headers: { 'x-admin-key': ADMIN_KEY } });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/bans', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await GET(new Request('http://x/api/admin/bans'));
    expect(res.status).toBe(401);
    expect(fetchBansMock).not.toHaveBeenCalled();
  });

  it('proxies the banned IPs when authorized', async () => {
    fetchBansMock.mockResolvedValue(['1.2.3.4']);
    const res = await GET(adminRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(['1.2.3.4']);
  });

  it('maps an upstream failure to a generic 502', async () => {
    fetchBansMock.mockRejectedValue(new AdminUpstreamError(500));
    const res = await GET(adminRequest());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });
});
