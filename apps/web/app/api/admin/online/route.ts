// Admin: who is online right now. Gated by the web admin key, then proxied to the Rust
// moderation API with the server-only ADMIN_TOKEN. A `tenant` query param scopes the
// snapshot to a single tenant's rooms (the panel manages one tenant at a time).
import { fetchOnline, AdminUpstreamError } from '../../../../lib/admin-server';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RoomSnapshot { tenant: string }
interface AdminStats { room_list: RoomSnapshot[] }

function scopeToTenant(stats: AdminStats, tenant: string): AdminStats {
  return { ...stats, room_list: stats.room_list.filter((room) => room.tenant === tenant) };
}

export async function GET(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'online' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const tenant = new URL(req.url).searchParams.get('tenant');
  try {
    const stats = (await fetchOnline()) as AdminStats;
    if (tenant === null) return Response.json(stats);
    return Response.json(scopeToTenant(stats, tenant));
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] online failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
