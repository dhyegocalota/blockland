import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth', () => ({ authRequest: vi.fn() }));
vi.mock('../../../../lib/mailer', () => ({ send: vi.fn() }));
vi.mock('../../../../emails/MagicLinkEmail', () => ({ MagicLinkEmail: vi.fn(() => null) }));

import { POST } from './route';
import { authRequest } from '../../../../lib/auth';
import { send } from '../../../../lib/mailer';

const authRequestMock = vi.mocked(authRequest);
const sendMock = vi.mocked(send);

function post(body: unknown): Request {
  return new Request('http://x/api/auth/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/auth/request', () => {
  it('rejects a missing field as invalid', async () => {
    const res = await POST(post({ tenant: 'acme', name: 'Ann' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
    expect(authRequestMock).not.toHaveBeenCalled();
  });

  it('sends the email with the magic link + code and never leaks them to the browser', async () => {
    authRequestMock.mockResolvedValue({ ok: true, token: 'tok123', code: '654321', name: 'Ann', email: 'a@x.io' });
    const res = await POST(post({ tenant: 'acme', name: 'Ann', email: 'a@x.io' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toBe('a@x.io');
    expect(arg.devMagicLink).toBe('http://x/claim?token=tok123');
    expect(arg.devCode).toBe('654321');
  });

  it('maps not_owner to an error response', async () => {
    authRequestMock.mockResolvedValue({ ok: false, error: 'not_owner' });
    const res = await POST(post({ tenant: 'acme', name: 'Ann', email: 'a@x.io' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'not_owner' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
