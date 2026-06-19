// Public: resolve a tenant's branding by id (used by the client per subdomain/query).
import { getTenant } from '../../../../lib/tenant-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const tenant = await getTenant(params.id);
  if (!tenant) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json(tenant);
}
