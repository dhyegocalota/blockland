import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/api', () => ({
  deleteTenant: vi.fn(),
}));

import { DELETE } from './route';
import { deleteTenant } from '../../../../../lib/api';

const deleteTenantMock = vi.mocked(deleteTenant);

const ADMIN_KEY = 'dev-admin-secret';

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
});

afterEach(() => vi.clearAllMocks());

describe('DELETE /api/admin/tenants/[id]', () => {
  it('returns 401 without a valid admin key', async () => {
    const res = await DELETE(new Request('http://x/api/admin/tenants/acme', { method: 'DELETE' }), {
      params: { id: 'acme' },
    });
    expect(res.status).toBe(401);
    expect(deleteTenantMock).not.toHaveBeenCalled();
  });

  it('deletes via the proxy when authorized', async () => {
    deleteTenantMock.mockResolvedValue(undefined);
    const res = await DELETE(
      new Request('http://x/api/admin/tenants/acme', {
        method: 'DELETE',
        headers: { 'x-admin-key': ADMIN_KEY },
      }),
      { params: { id: 'acme' } },
    );
    expect(deleteTenantMock).toHaveBeenCalledWith('acme');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
