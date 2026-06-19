import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/admin-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/admin-server')>(
    '../../../../lib/admin-server',
  );
  return { ...actual, banIp: vi.fn() };
});

import { POST } from './route';
import { banIp, AdminUpstreamError } from '../../../../lib/admin-server';

const banIpMock = vi.mocked(banIp);
const ADMIN_KEY = 'dev-admin-secret';

function adminRequest(body: unknown): Request {
  return new Request('http://x/api/admin/ban', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/ban', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await POST(
      new Request('http://x/api/admin/ban', { method: 'POST', body: JSON.stringify({ ip: '1.2.3.4' }) }),
    );
    expect(res.status).toBe(401);
    expect(banIpMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid ip', async () => {
    const res = await POST(adminRequest({ ip: '999.0.0.1' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_ip' });
    expect(banIpMock).not.toHaveBeenCalled();
  });

  it('bans via the proxy when authorized and valid', async () => {
    banIpMock.mockResolvedValue(['1.2.3.4']);
    const res = await POST(adminRequest({ ip: '1.2.3.4' }));
    expect(banIpMock).toHaveBeenCalledWith('1.2.3.4');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(['1.2.3.4']);
  });

  it('maps an upstream failure to a generic 502', async () => {
    banIpMock.mockRejectedValue(new AdminUpstreamError(500));
    const res = await POST(adminRequest({ ip: '1.2.3.4' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });
});
