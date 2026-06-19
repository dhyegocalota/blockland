// Admin: list all tenants and create/update one. Protected by the fixed admin key.
import { listTenants, upsertTenant } from '../../../../lib/tenant-store';
import { TENANT_FIELDS } from '../../../../lib/builtins';
import { isAdmin } from '../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  if (!isAdmin(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json(await listTenants());
}

export async function POST(req) {
  if (!isAdmin(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const id = String(body.id || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(id)) {
    return Response.json({ error: 'invalid_id', msg: 'use 2-32 chars: a-z, 0-9, -' }, { status: 400 });
  }
  const tenant = { id };
  for (const f of TENANT_FIELDS) {
    if (f === 'id') continue;
    const v = body[f];
    if (typeof v !== 'string' || v.trim() === '') {
      return Response.json({ error: 'missing_field', field: f }, { status: 400 });
    }
    tenant[f] = v;
  }

  const saved = await upsertTenant(tenant);
  return Response.json(saved);
}
