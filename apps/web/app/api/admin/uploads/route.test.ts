import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/api', () => ({
  uploadAsset: vi.fn(),
}));

import { POST } from './route';
import { uploadAsset } from '../../../../lib/api';

const uploadAssetMock = vi.mocked(uploadAsset);

const ADMIN_KEY = 'dev-admin-secret';

function pngFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' });
}

function uploadRequest(form: FormData, withKey = true): Request {
  return new Request('http://x/api/admin/uploads', {
    method: 'POST',
    headers: withKey ? { 'x-admin-key': ADMIN_KEY } : {},
    body: form,
  });
}

beforeEach(() => {
  process.env.ADMIN_KEY = ADMIN_KEY;
  uploadAssetMock.mockResolvedValue({ url: 'https://cdn/asset.png' });
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/uploads', () => {
  it('returns 401 without a valid admin key', async () => {
    const form = new FormData();
    form.set('tenantId', 'acme');
    form.set('kind', 'avatar');
    form.set('file', pngFile());
    const res = await POST(uploadRequest(form, false));
    expect(res.status).toBe(401);
    expect(uploadAssetMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid tenant id', async () => {
    const form = new FormData();
    form.set('tenantId', 'A');
    form.set('kind', 'avatar');
    form.set('file', pngFile());
    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_tenant' });
  });

  it('rejects an unknown kind', async () => {
    const form = new FormData();
    form.set('tenantId', 'acme');
    form.set('kind', 'banner');
    form.set('file', pngFile());
    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_kind' });
  });

  it('rejects a missing file', async () => {
    const form = new FormData();
    form.set('tenantId', 'acme');
    form.set('kind', 'avatar');
    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'missing_file' });
  });

  it('rejects an unsupported content type', async () => {
    const form = new FormData();
    form.set('tenantId', 'acme');
    form.set('kind', 'avatar');
    form.set('file', new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' }));
    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_media_type' });
    expect(uploadAssetMock).not.toHaveBeenCalled();
  });

  it('builds the avatar key and forwards the bytes', async () => {
    const form = new FormData();
    form.set('tenantId', 'acme');
    form.set('kind', 'avatar');
    form.set('file', pngFile());
    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://cdn/asset.png' });
    expect(uploadAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'tenants/acme/avatar.png', contentType: 'image/png' }),
    );
  });

  it('builds the face key from the face kind and jpeg extension', async () => {
    const form = new FormData();
    form.set('tenantId', 'acme');
    form.set('kind', 'face');
    form.set('file', new File([new Uint8Array([1])], 'f.jpg', { type: 'image/jpeg' }));
    const res = await POST(uploadRequest(form));
    expect(res.status).toBe(200);
    expect(uploadAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'tenants/acme/face.jpg', contentType: 'image/jpeg' }),
    );
  });
});
