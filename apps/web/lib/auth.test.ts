import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ signedFetch: vi.fn() }));

import { authRequest, authVerifyToken, authVerifyCode, authLogout, authRename } from './auth';
import { signedFetch } from './api';

const signedFetchMock = vi.mocked(signedFetch);

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200 });
}

afterEach(() => vi.clearAllMocks());

describe('auth client', () => {
  it('authRequest posts to the request route and returns the token + code', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: true, token: 'abc', code: '123456', name: 'Ann', email: 'a@x.io' }));
    const result = await authRequest({ tenant: 'acme', name: 'Ann', email: 'a@x.io' });
    expect(signedFetchMock).toHaveBeenCalledWith('POST', '/internal/auth/request', {
      tenant: 'acme',
      name: 'Ann',
      email: 'a@x.io',
    });
    expect(result).toEqual({ ok: true, token: 'abc', code: '123456', name: 'Ann', email: 'a@x.io' });
  });

  it('authRequest surfaces a not_owner failure', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: false, error: 'not_owner' }));
    expect(await authRequest({ tenant: 'acme', name: 'Ann', email: 'b@x.io' })).toEqual({
      ok: false,
      error: 'not_owner',
    });
  });

  it('authVerifyToken posts only the token', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: true, tenant: 'acme', name: 'Ann', claim: 'cl' }));
    const result = await authVerifyToken('tok');
    expect(signedFetchMock).toHaveBeenCalledWith('POST', '/internal/auth/verify', { token: 'tok' });
    expect(result).toEqual({ ok: true, tenant: 'acme', name: 'Ann', claim: 'cl' });
  });

  it('authVerifyCode posts tenant, name and code', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: false }));
    await authVerifyCode({ tenant: 'acme', name: 'Ann', code: '000000' });
    expect(signedFetchMock).toHaveBeenCalledWith('POST', '/internal/auth/verify', {
      tenant: 'acme',
      name: 'Ann',
      code: '000000',
    });
  });

  it('authLogout posts the claim triple', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: true }));
    const result = await authLogout({ tenant: 'acme', name: 'Ann', claim: 'cl' });
    expect(signedFetchMock).toHaveBeenCalledWith('POST', '/internal/auth/logout', {
      tenant: 'acme',
      name: 'Ann',
      claim: 'cl',
    });
    expect(result).toEqual({ ok: true });
  });

  it('authRename posts the tenant, claim and new name and returns the new name', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: true, name: 'Bea' }));
    const result = await authRename({ tenant: 'acme', claim: 'cl', newName: 'Bea' });
    expect(signedFetchMock).toHaveBeenCalledWith('POST', '/internal/auth/rename', {
      tenant: 'acme',
      claim: 'cl',
      newName: 'Bea',
    });
    expect(result).toEqual({ ok: true, name: 'Bea' });
  });

  it('authRename surfaces a name_taken failure', async () => {
    signedFetchMock.mockResolvedValue(ok({ ok: false, error: 'name_taken' }));
    expect(await authRename({ tenant: 'acme', claim: 'cl', newName: 'Bea' })).toEqual({
      ok: false,
      error: 'name_taken',
    });
  });

  it('throws when the upstream is not ok', async () => {
    signedFetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(authVerifyToken('tok')).rejects.toThrow();
  });
});
