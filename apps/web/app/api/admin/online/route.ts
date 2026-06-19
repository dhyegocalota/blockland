// Admin: who is online right now. Gated by the web admin key, then proxied to the Rust
// moderation API with the server-only ADMIN_TOKEN.
import { fetchOnline, AdminUpstreamError } from '../../../../lib/admin-server';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'online' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    return Response.json(await fetchOnline());
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] online failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
