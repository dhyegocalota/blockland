// Admin: grant or revoke a tenant account's admin flag. Gated by the web admin key, validates the
// payload, then proxies to the Rust moderation API with the server-only ADMIN_TOKEN.
import { setAccountAdmin, AdminUpstreamError } from '../../../../lib/admin-server';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'set-admin' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const tenant = String(body.tenant ?? '').trim();
  const name = String(body.name ?? '').trim();
  const admin = body.admin;
  if (tenant === '' || name === '' || typeof admin !== 'boolean') {
    return Response.json({ error: 'invalid_payload' }, { status: 400 });
  }

  try {
    const result = await setAccountAdmin({ tenant, name, admin });
    console.log('[api:admin] set-admin', { tenant, name, admin });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] set-admin failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
