// Public: resolve a tenant's branding by id. Proxies to the internal data API.
import { getTenant } from '../../../../lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const tenant = await getTenant(params.id);
  if (!tenant) {
    console.log('[api:tenant] miss', { id: params.id });
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  console.log('[api:tenant] fetched', { id: tenant.id, name: tenant.name });
  return Response.json(tenant);
}
