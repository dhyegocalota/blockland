// Admin: grant or revoke a tenant account's moderator flag. Gated by the web admin key, validates
// the payload, then proxies to the Rust moderation API with the server-only ADMIN_TOKEN.
import { setAccountModerator, AdminUpstreamError } from '../../../../lib/admin-server';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'set-moderator' });
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
  const email = String(body.email ?? '').trim().toLowerCase();
  const moderator = body.moderator;
  if (tenant === '' || typeof moderator !== 'boolean') {
    return Response.json({ error: 'invalid_payload' }, { status: 400 });
  }
  if (name === '' && email === '') {
    return Response.json({ error: 'invalid_payload' }, { status: 400 });
  }

  const target = email === '' ? { name } : { email };
  try {
    const result = await setAccountModerator({ tenant, moderator, ...target });
    console.log('[api:admin] set-moderator', { tenant, ...target, moderator });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] set-moderator failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
