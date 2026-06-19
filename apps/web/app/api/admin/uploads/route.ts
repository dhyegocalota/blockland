// Admin: upload a tenant asset (avatar or face texture) through the signed Storage proxy.
// Protected by the fixed admin key; builds a tenant-scoped key and forwards the raw bytes
// to the Rust internal upload endpoint, which validates type/size and stores the object.
import { uploadAsset } from '../../../../lib/api';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT_ID = /^[a-z0-9-]{2,32}$/;
const ASSET_KINDS = ['avatar', 'face'] as const;
type AssetKind = (typeof ASSET_KINDS)[number];

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'upload' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'invalid_form' }, { status: 400 });
  }

  const tenantId = String(form.get('tenantId') ?? '').trim().toLowerCase();
  if (!TENANT_ID.test(tenantId)) {
    return Response.json({ error: 'invalid_tenant' }, { status: 400 });
  }

  const kind = String(form.get('kind') ?? '');
  if (!isAssetKind(kind)) {
    return Response.json({ error: 'invalid_kind' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'missing_file' }, { status: 400 });
  }

  const extension = EXTENSION_BY_TYPE[file.type];
  if (!extension) {
    return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
  }

  const key = `tenants/${tenantId}/${kind}.${extension}`;
  const bytes = await file.arrayBuffer();
  const { url } = await uploadAsset({ key, contentType: file.type, bytes });
  console.log('[api:admin] upload', { tenantId, kind, key });
  return Response.json({ url });
}
