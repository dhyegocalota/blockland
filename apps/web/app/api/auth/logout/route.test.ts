import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth', () => ({ authLogout: vi.fn() }));

import { POST } from './route';
import { authLogout } from '../../../../lib/auth';

const logoutMock = vi.mocked(authLogout);

function post(body: unknown): Request {
  return new Request('http://x/api/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/auth/logout', () => {
  it('proxies the claim triple and returns the result', async () => {
    logoutMock.mockResolvedValue({ ok: true });
    const res = await POST(post({ tenant: 'teo', name: 'Ann', claim: 'cl' }));
    expect(logoutMock).toHaveBeenCalledWith({ tenant: 'teo', name: 'Ann', claim: 'cl' });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects an incomplete body', async () => {
    const res = await POST(post({ tenant: 'teo', name: 'Ann' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false });
    expect(logoutMock).not.toHaveBeenCalled();
  });
});
