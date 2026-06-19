// Admin: list all tenants and create/update one. Protected by the fixed admin key,
// then proxied to the Rust internal data API.
import { listTenants, upsertTenant } from '../../../../lib/api';
import { TENANT_FIELDS, type Tenant } from '../../../../lib/builtins';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'list' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return Response.json(await listTenants());
}

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'create' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const id = String(body.id || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(id)) {
    return Response.json({ error: 'invalid_id', msg: 'use 2-32 chars: a-z, 0-9, -' }, { status: 400 });
  }
  const tenant: Partial<Tenant> = { id };
  for (const field of TENANT_FIELDS) {
    if (field === 'id') continue;
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return Response.json({ error: 'missing_field', field }, { status: 400 });
    }
    tenant[field] = value;
  }

  const saved = await upsertTenant(tenant as Tenant);
  console.log('[api:admin] create', { id });
  return Response.json(saved);
}
