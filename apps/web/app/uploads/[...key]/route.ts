// Public proxy that streams a stored tenant asset to the browser. The storage backend writes the
// file on the game server and returns a `/uploads/<key>` URL when there is no public CDN (the
// local-fs dev/CI backend); this route reads those bytes back through the signed internal channel so
// the lobby avatar and /admin preview load on the same origin. Read-only and tenant-scoped.
import { fetchAsset } from '../../../lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The key shape mirrors the server's `is_valid_key`: `tenants/<slug>/<filename>`. The tenant is a
// dot-free slug; the filename may contain dots (the extension) but never a traversal segment.
const SLUG = /^[a-z0-9-]+$/;
const FILENAME = /^[a-z0-9._-]+$/;
const CACHE_CONTROL = 'public, max-age=300';

function tenantKey(segments: string[]): string | null {
  if (segments.length !== 3) return null;
  const [prefix, tenant, file] = segments;
  if (prefix !== 'tenants') return null;
  if (!SLUG.test(tenant)) return null;
  if (file === '..' || !FILENAME.test(file)) return null;
  return segments.join('/');
}

export async function GET(_req: Request, { params }: { params: { key: string[] } }) {
  const key = tenantKey(params.key);
  if (!key) return new Response('invalid_key', { status: 400 });

  const asset = await fetchAsset(key);
  if (!asset) return new Response('not_found', { status: 404 });

  return new Response(asset.bytes, {
    headers: { 'content-type': asset.contentType, 'cache-control': CACHE_CONTROL },
  });
}
