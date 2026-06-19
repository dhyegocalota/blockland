import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/admin-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/admin-server')>(
    '../../../../lib/admin-server',
  );
  return { ...actual, unbanIp: vi.fn() };
});

import { POST } from './route';
import { unbanIp, AdminUpstreamError } from '../../../../lib/admin-server';

const unbanIpMock = vi.mocked(unbanIp);
const ADMIN_KEY = 'dev-admin-secret';

function adminRequest(body: unknown): Request {
  return new Request('http://x/api/admin/unban', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/unban', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await POST(
      new Request('http://x/api/admin/unban', { method: 'POST', body: JSON.stringify({ ip: '1.2.3.4' }) }),
    );
    expect(res.status).toBe(401);
    expect(unbanIpMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid ip', async () => {
    const res = await POST(adminRequest({ ip: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_ip' });
    expect(unbanIpMock).not.toHaveBeenCalled();
  });

  it('unbans via the proxy when authorized and valid', async () => {
    unbanIpMock.mockResolvedValue([]);
    const res = await POST(adminRequest({ ip: '1.2.3.4' }));
    expect(unbanIpMock).toHaveBeenCalledWith('1.2.3.4');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('maps an upstream failure to a generic 502', async () => {
    unbanIpMock.mockRejectedValue(new AdminUpstreamError(500));
    const res = await POST(adminRequest({ ip: '1.2.3.4' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });
});
