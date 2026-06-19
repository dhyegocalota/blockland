import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidIp, fetchOnline, banIp, AdminUpstreamError } from './admin-server';

const ADMIN_TOKEN = 'rust-admin-token';

beforeEach(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.API_URL = 'http://rust';
});

afterEach(() => vi.restoreAllMocks());

describe('isValidIp', () => {
  it('accepts well-formed IPv4', () => {
    expect(isValidIp('1.2.3.4')).toBe(true);
    expect(isValidIp('255.255.255.255')).toBe(true);
  });

  it('accepts IPv6', () => {
    expect(isValidIp('::1')).toBe(true);
    expect(isValidIp('2001:db8::ff00:42:8329')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isValidIp('')).toBe(false);
    expect(isValidIp('256.0.0.1')).toBe(false);
    expect(isValidIp('1.2.3')).toBe(false);
    expect(isValidIp('not-an-ip')).toBe(false);
  });
});

describe('adminFetch', () => {
  it('attaches the server token and returns parsed JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ online: 0 }), { status: 200 }),
    );

    const result = await fetchOnline();

    expect(result).toEqual({ online: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://rust/admin/stats');
    expect((init?.headers as Record<string, string>)['x-admin-token']).toBe(ADMIN_TOKEN);
  });

  it('serializes the body for ban', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(['1.2.3.4']), { status: 200 }),
    );

    await banIp('1.2.3.4');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://rust/admin/ban');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ ip: '1.2.3.4' }));
  });

  it('throws AdminUpstreamError on a non-ok upstream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(fetchOnline()).rejects.toBeInstanceOf(AdminUpstreamError);
  });

  it('throws when ADMIN_TOKEN is unset', async () => {
    delete process.env.ADMIN_TOKEN;
    await expect(fetchOnline()).rejects.toThrow('ADMIN_TOKEN is not set');
  });
});
