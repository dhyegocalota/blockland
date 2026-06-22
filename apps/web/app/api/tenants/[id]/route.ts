// Public: resolve a tenant's branding by id. Proxies to the internal data API.
import { getTenant } from '../../../../lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Never let a shared/edge cache hold a tenant response: a stale entry from before a schema change
// (e.g. the old wide shape with no `image`) keeps being served on the bare URL and breaks the logo.
const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const tenant = await getTenant(params.id);
  if (!tenant) {
    console.log('[api:tenant] miss', { id: params.id });
    return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }
  console.log('[api:tenant] fetched', { id: tenant.id, name: tenant.name });
  return Response.json(tenant, { headers: NO_STORE });
}
