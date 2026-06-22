import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api', () => ({
  fetchAsset: vi.fn(),
}));

import { GET } from './route';
import { fetchAsset } from '../../../lib/api';

const fetchAssetMock = vi.mocked(fetchAsset);

function get(key: string[]) {
  return GET(new Request('http://x/uploads'), { params: { key } });
}

afterEach(() => vi.clearAllMocks());

describe('GET /uploads/[...key]', () => {
  it('streams the asset bytes with its content-type and a cache header', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    fetchAssetMock.mockResolvedValue({ contentType: 'image/png', bytes });
    const res = await get(['tenants', 'acme', 'image.png']);
    expect(fetchAssetMock).toHaveBeenCalledWith('tenants/acme/image.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('returns 404 when the asset is missing', async () => {
    fetchAssetMock.mockResolvedValue(null);
    const res = await get(['tenants', 'acme', 'image.png']);
    expect(res.status).toBe(404);
  });

  it('rejects a key outside the tenants namespace', async () => {
    const res = await get(['secrets', 'acme', 'image.png']);
    expect(res.status).toBe(400);
    expect(fetchAssetMock).not.toHaveBeenCalled();
  });

  it('rejects a traversal segment', async () => {
    const res = await get(['tenants', '..', 'image.png']);
    expect(res.status).toBe(400);
    expect(fetchAssetMock).not.toHaveBeenCalled();
  });

  it('rejects a key with the wrong number of segments', async () => {
    const res = await get(['tenants', 'acme', 'sub', 'image.png']);
    expect(res.status).toBe(400);
    expect(fetchAssetMock).not.toHaveBeenCalled();
  });
});
