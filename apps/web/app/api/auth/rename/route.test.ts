import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth', () => ({ authRename: vi.fn() }));

import { POST } from './route';
import { authRename } from '../../../../lib/auth';

const renameMock = vi.mocked(authRename);

function post(body: unknown): Request {
  return new Request('http://x/api/auth/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/auth/rename', () => {
  it('proxies a valid rename and returns the new name', async () => {
    renameMock.mockResolvedValue({ ok: true, name: 'Bea' });
    const res = await POST(post({ tenant: 'acme', claim: 'cl', newName: ' Bea ' }));
    expect(renameMock).toHaveBeenCalledWith({ tenant: 'acme', claim: 'cl', newName: 'Bea' });
    expect(await res.json()).toEqual({ ok: true, name: 'Bea' });
  });

  it('surfaces a name_taken failure from the server', async () => {
    renameMock.mockResolvedValue({ ok: false, error: 'name_taken' });
    const res = await POST(post({ tenant: 'acme', claim: 'cl', newName: 'Bea' }));
    expect(await res.json()).toEqual({ ok: false, error: 'name_taken' });
  });

  it('rejects a missing claim without calling the proxy', async () => {
    const res = await POST(post({ tenant: 'acme', newName: 'Bea' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rejects a name longer than the cap', async () => {
    const res = await POST(post({ tenant: 'acme', claim: 'cl', newName: 'x'.repeat(17) }));
    expect(res.status).toBe(400);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rejects a non-json body', async () => {
    const bad = new Request('http://x/api/auth/rename', { method: 'POST', body: 'not json' });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(renameMock).not.toHaveBeenCalled();
  });
});
