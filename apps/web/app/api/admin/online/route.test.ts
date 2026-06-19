import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/admin-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/admin-server')>(
    '../../../../lib/admin-server',
  );
  return { ...actual, fetchOnline: vi.fn() };
});

import { GET } from './route';
import { fetchOnline, AdminUpstreamError } from '../../../../lib/admin-server';

const fetchOnlineMock = vi.mocked(fetchOnline);
const ADMIN_KEY = 'dev-admin-secret';

function adminRequest(): Request {
  return new Request('http://x/api/admin/online', { headers: { 'x-admin-key': ADMIN_KEY } });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/online', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await GET(new Request('http://x/api/admin/online'));
    expect(res.status).toBe(401);
    expect(fetchOnlineMock).not.toHaveBeenCalled();
  });

  it('proxies the online stats when authorized', async () => {
    fetchOnlineMock.mockResolvedValue({ online: 2, rooms: 1, tenants: [], room_list: [] });
    const res = await GET(adminRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: 2, rooms: 1, tenants: [], room_list: [] });
  });

  it('maps an upstream failure to a generic 502', async () => {
    fetchOnlineMock.mockRejectedValue(new AdminUpstreamError(503));
    const res = await GET(adminRequest());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });
});
