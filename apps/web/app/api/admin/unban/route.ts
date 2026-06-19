// Admin: unban an IP globally. Gated by the web admin key, validates the IP shape, then
// proxies to the Rust moderation API with the server-only ADMIN_TOKEN.
import { unbanIp, isValidIp, AdminUpstreamError } from '../../../../lib/admin-server';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'unban' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const ip = String(body.ip ?? '').trim();
  if (!isValidIp(ip)) {
    return Response.json({ error: 'invalid_ip' }, { status: 400 });
  }

  try {
    const bans = await unbanIp(ip);
    console.log('[api:admin] unban', { ip });
    return Response.json(bans);
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] unban failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
