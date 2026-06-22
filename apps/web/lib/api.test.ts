import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GOLDEN = {
  secret: 'bl-internal-test-secret',
  method: 'POST',
  path: '/internal/tenants',
  ts: '1700000000',
  nonce: '0123456789abcdef',
  body: '{"id":"x"}',
  signature: '8400280bdd1590664580d3486483a3cf5d75a92f1e0534ea6f7a596e816051b2',
};

let api: typeof import('./api');

beforeEach(async () => {
  vi.resetModules();
  process.env.INTERNAL_HMAC_SECRET = GOLDEN.secret;
  process.env.API_URL = 'http://rust.test:9090';
  api = await import('./api');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api signer', () => {
  it('reproduces the golden signature for the fixed inputs', () => {
    const signature = api.sign({
      method: GOLDEN.method,
      path: GOLDEN.path,
      ts: GOLDEN.ts,
      nonce: GOLDEN.nonce,
      body: GOLDEN.body,
    });
    expect(signature).toBe(GOLDEN.signature);
  });
});

describe('verifyInternalSignature', () => {
  it('accepts a fresh, correctly signed request and rejects a tampered one', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const params = { method: 'POST', path: '/api/internal/approval-notify', ts, nonce: 'abc', body: '{"name":"Kid"}' };
    const signature = api.sign(params);
    expect(api.verifyInternalSignature({ ...params, signature })).toBe(true);
    expect(api.verifyInternalSignature({ ...params, signature, body: '{"name":"Other"}' })).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const ts = (Math.floor(Date.now() / 1000) - 120).toString();
    const params = { method: 'POST', path: '/api/internal/approval-notify', ts, nonce: 'abc', body: '{}' };
    const signature = api.sign(params);
    expect(api.verifyInternalSignature({ ...params, signature })).toBe(false);
  });
});

describe('signedFetch', () => {
  it('sets the three signing headers and hits the right URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }));

    await api.signedFetch('GET', '/internal/tenants');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://rust.test:9090/internal/tenants');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-bl-ts']).toMatch(/^\d+$/);
    expect(headers['x-bl-nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(headers['x-bl-sig']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the request body and matches the golden signature', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.spyOn(Date, 'now').mockReturnValue(Number(GOLDEN.ts) * 1000);

    await api.signedFetch('POST', '/internal/tenants', { id: 'x' });

    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(init?.body).toBe(GOLDEN.body);
    expect(headers['x-bl-ts']).toBe(GOLDEN.ts);
    const expected = api.sign({
      method: GOLDEN.method,
      path: GOLDEN.path,
      ts: GOLDEN.ts,
      nonce: headers['x-bl-nonce'],
      body: GOLDEN.body,
    });
    expect(headers['x-bl-sig']).toBe(expected);
  });
});

describe('typed helpers', () => {
  it('getTenant returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    expect(await api.getTenant('nope')).toBeNull();
  });

  it('getTenant returns the tenant on 200', async () => {
    const tenant = { id: 'acme', name: 'Acme' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tenant), { status: 200 }),
    );
    expect(await api.getTenant('acme')).toMatchObject(tenant);
  });

  it('topScores requests the leaderboard path with limit', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }));
    await api.topScores({ tenant: 'acme', limit: 5 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://rust.test:9090/internal/leaderboard/acme?limit=5');
  });

  it('topScores adds the window=month param for the last-30-days board', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }));
    await api.topScores({ tenant: 'acme', window: 'month', limit: 5 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://rust.test:9090/internal/leaderboard/acme?limit=5&window=month',
    );
  });

  it('deleteTenant throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(api.deleteTenant('acme')).rejects.toThrow();
  });
});

describe('uploadAsset', () => {
  it('signs a POST to the uploads path with the raw bytes hashed', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ url: 'https://cdn/x.png' }), { status: 200 }));
    vi.spyOn(Date, 'now').mockReturnValue(Number(GOLDEN.ts) * 1000);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await api.uploadAsset({
      key: 'tenants/acme/avatar.png',
      contentType: 'image/png',
      bytes,
    });

    expect(result).toEqual({ url: 'https://cdn/x.png' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'http://rust.test:9090/internal/uploads?key=tenants%2Facme%2Favatar.png&content_type=image%2Fpng',
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(bytes);
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('image/png');
    expect(headers['x-bl-ts']).toBe(GOLDEN.ts);
    const expected = api.sign({
      method: 'POST',
      path: '/internal/uploads?key=tenants%2Facme%2Favatar.png&content_type=image%2Fpng',
      ts: GOLDEN.ts,
      nonce: headers['x-bl-nonce'],
      body: bytes,
    });
    expect(headers['x-bl-sig']).toBe(expected);
  });

  it('accepts an ArrayBuffer body and hashes it identically to its Uint8Array view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://cdn/y.png' }), { status: 200 }),
    );
    const buffer = new Uint8Array([9, 8, 7]).buffer;
    const result = await api.uploadAsset({
      key: 'tenants/acme/face.png',
      contentType: 'image/png',
      bytes: buffer,
    });
    expect(result).toEqual({ url: 'https://cdn/y.png' });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 415 }));
    await expect(
      api.uploadAsset({ key: 'tenants/acme/avatar.png', contentType: 'image/gif', bytes: new Uint8Array() }),
    ).rejects.toThrow();
  });
});
