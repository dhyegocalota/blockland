// Log out: clears the claim for (tenant, name) on the Rust server, but only when the supplied claim
// token matches the live session. The kicked player's socket is then dropped on the next tick.
import { authLogout } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const tenant = String(body.tenant ?? '').trim();
  const name = String(body.name ?? '').trim();
  const claim = String(body.claim ?? '').trim();
  if (!tenant || !name || !claim) {
    return Response.json({ ok: false }, { status: 400 });
  }

  const result = await authLogout({ tenant, name, claim });
  return Response.json(result);
}
