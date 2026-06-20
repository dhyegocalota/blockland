import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth', () => ({ authVerifyToken: vi.fn(), authVerifyCode: vi.fn() }));

import { POST } from './route';
import { authVerifyToken, authVerifyCode } from '../../../../lib/auth';

const verifyTokenMock = vi.mocked(authVerifyToken);
const verifyCodeMock = vi.mocked(authVerifyCode);

function post(body: unknown): Request {
  return new Request('http://x/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/auth/verify', () => {
  it('verifies by token when one is given', async () => {
    verifyTokenMock.mockResolvedValue({ ok: true, tenant: 'teo', name: 'Ann', claim: 'cl', is_admin: true, is_moderator: false });
    const res = await POST(post({ token: 'tok' }));
    expect(verifyTokenMock).toHaveBeenCalledWith('tok');
    expect(verifyCodeMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, tenant: 'teo', name: 'Ann', claim: 'cl', is_admin: true, is_moderator: false });
  });

  it('verifies by code when no token is given', async () => {
    verifyCodeMock.mockResolvedValue({ ok: false });
    const res = await POST(post({ tenant: 'teo', name: 'Ann', code: '000000' }));
    expect(verifyCodeMock).toHaveBeenCalledWith({ tenant: 'teo', name: 'Ann', code: '000000' });
    expect(await res.json()).toEqual({ ok: false });
  });

  it('rejects when neither a token nor a full code triple is present', async () => {
    const res = await POST(post({ tenant: 'teo' }));
    expect(res.status).toBe(400);
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(verifyCodeMock).not.toHaveBeenCalled();
  });
});
