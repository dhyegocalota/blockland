import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/admin-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/admin-server')>(
    '../../../../lib/admin-server',
  );
  return { ...actual, setAccountAdmin: vi.fn() };
});

import { POST } from './route';
import { setAccountAdmin, AdminUpstreamError } from '../../../../lib/admin-server';

const setAccountAdminMock = vi.mocked(setAccountAdmin);
const ADMIN_KEY = 'dev-admin-secret';

function adminRequest(body: unknown): Request {
  return new Request('http://x/api/admin/set-admin', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/set-admin', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await POST(
      new Request('http://x/api/admin/set-admin', { method: 'POST', body: JSON.stringify({ tenant: 'teo', name: 'Ana', admin: true }) }),
    );
    expect(res.status).toBe(401);
    expect(setAccountAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a payload missing fields or with a non-boolean admin', async () => {
    const res = await POST(adminRequest({ tenant: 'teo', name: 'Ana', admin: 'yes' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(setAccountAdminMock).not.toHaveBeenCalled();
  });

  it('rejects a payload with neither name nor email', async () => {
    const res = await POST(adminRequest({ tenant: 'teo', admin: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(setAccountAdminMock).not.toHaveBeenCalled();
  });

  it('grants admin via the proxy when authorized and valid', async () => {
    setAccountAdminMock.mockResolvedValue([{ name: 'Ana', is_admin: true }]);
    const res = await POST(adminRequest({ tenant: 'teo', name: 'Ana', admin: true }));
    expect(setAccountAdminMock).toHaveBeenCalledWith({ tenant: 'teo', admin: true, name: 'Ana' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'Ana', is_admin: true }]);
  });

  it('grants admin by email, lowercased, when an email is given', async () => {
    setAccountAdminMock.mockResolvedValue([]);
    const res = await POST(adminRequest({ tenant: 'teo', email: 'Ana@Example.com', admin: true }));
    expect(setAccountAdminMock).toHaveBeenCalledWith({ tenant: 'teo', admin: true, email: 'ana@example.com' });
    expect(res.status).toBe(200);
  });

  it('maps an upstream failure to a generic 502', async () => {
    setAccountAdminMock.mockRejectedValue(new AdminUpstreamError(500));
    const res = await POST(adminRequest({ tenant: 'teo', name: 'Ana', admin: false }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });
});
