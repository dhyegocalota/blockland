// Rename a logged-in account without re-emailing: the Rust server validates the claim, frees/takes the
// new name within the tenant, records a timeline event and notifies the live room. The browser never
// reaches the internal route directly — this proxy signs the HMAC channel.
import { authRename } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_MAX_LENGTH = 16;

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const tenant = typeof body.tenant === 'string' ? body.tenant.trim() : '';
  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
  if (!tenant || !claim || !newName || newName.length > NAME_MAX_LENGTH) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const result = await authRename({ tenant, claim, newName });
  return Response.json(result);
}
