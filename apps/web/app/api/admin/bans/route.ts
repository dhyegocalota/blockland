// Admin: list globally banned IPs. Gated by the web admin key, then proxied to the Rust
// moderation API with the server-only ADMIN_TOKEN.
import { fetchBans, AdminUpstreamError } from '../../../../lib/admin-server';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'bans' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    return Response.json(await fetchBans());
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] bans failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
