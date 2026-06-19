// Admin: list the accounts of a tenant (with their admin flag). Gated by the web admin key, then
// proxied to the Rust moderation API with the server-only ADMIN_TOKEN.
import { fetchAccounts, AdminUpstreamError } from '../../../../../lib/admin-server';
import { isAdmin } from '../../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { tenant: string } }) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'accounts' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const tenant = params.tenant.trim();
  if (tenant === '') {
    return Response.json({ error: 'invalid_tenant' }, { status: 400 });
  }
  try {
    return Response.json(await fetchAccounts(tenant));
  } catch (error) {
    const status = error instanceof AdminUpstreamError ? 502 : 500;
    console.log('[api:admin] accounts failed', { status });
    return Response.json({ error: 'upstream_error' }, { status });
  }
}
