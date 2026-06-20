import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from './turnstile';

function stubFetch(response: { ok: boolean; json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
  vi.unstubAllEnvs();
});

describe('verifyTurnstile', () => {
  it('passes without calling Cloudflare when the secret is unset (dev)', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const fetchMock = stubFetch({ ok: true, json: () => Promise.resolve({ success: true }) });
    await expect(verifyTurnstile({ token: '', remoteIp: null })).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty token when a secret is configured', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    const fetchMock = stubFetch({ ok: true, json: () => Promise.resolve({ success: true }) });
    await expect(verifyTurnstile({ token: '', remoteIp: null })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the Cloudflare verdict and forwards secret, token and ip', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    const fetchMock = stubFetch({ ok: true, json: () => Promise.resolve({ success: true }) });
    await expect(verifyTurnstile({ token: 'tok', remoteIp: '203.0.113.7' })).resolves.toBe(true);
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('secret')).toBe('secret');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('203.0.113.7');
  });

  it('fails closed when Cloudflare reports the token invalid', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    stubFetch({ ok: true, json: () => Promise.resolve({ success: false }) });
    await expect(verifyTurnstile({ token: 'tok', remoteIp: null })).resolves.toBe(false);
  });

  it('fails closed when the verify request errors', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret');
    stubFetch({ ok: false });
    await expect(verifyTurnstile({ token: 'tok', remoteIp: null })).resolves.toBe(false);
  });
});
