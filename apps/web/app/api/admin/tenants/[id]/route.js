// Admin: delete a tenant. Protected by the fixed admin key.
import { deleteTenant } from '../../../../../lib/tenant-store';
import { isAdmin } from '../../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req, { params }) {
  if (!isAdmin(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  await deleteTenant(params.id);
  return Response.json({ ok: true });
}
