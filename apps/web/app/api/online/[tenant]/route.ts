// Public: how many players (and who) are online in a tenant right now, for the lobby. Proxies the
// server's public /online endpoint (no auth) and lets the CDN cache it briefly since it changes often.
import { fetchOnline } from '../../../../lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'public, s-maxage=10, stale-while-revalidate=20';

export async function GET(_req: Request, { params }: { params: { tenant: string } }) {
  const tenant = params.tenant.trim();
  if (tenant === '') return Response.json({ count: 0, names: [] }, { status: 400 });
  try {
    const presence = await fetchOnline(tenant);
    return Response.json(presence, { headers: { 'Cache-Control': CACHE_CONTROL } });
  } catch {
    return Response.json({ count: 0, names: [] });
  }
}
