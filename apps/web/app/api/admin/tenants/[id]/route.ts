// Admin: delete a tenant. Protected by the fixed admin key, then proxied to the Rust API.
import { deleteTenant } from '../../../../../lib/rust-api';
import { isAdmin } from '../../../../../lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  if (!isAdmin(req)) {
    console.log('[api:admin] unauthorized', { action: 'delete', id: params.id });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  await deleteTenant(params.id);
  console.log('[api:admin] delete', { id: params.id });
  return Response.json({ ok: true });
}
