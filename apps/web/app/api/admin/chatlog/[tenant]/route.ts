// Lobby admin: the recent chat log for a tenant. The browser POSTs its claim (kept out of the URL so
// it never leaks into logs/CDN); this proxy signs the HMAC channel and the server resolves the claim
// to an admin of the tenant. A non-admin claim is rejected upstream with 401/403.
import { fetchChatLog } from '../../../../../lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { tenant: string } }) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid' }, { status: 400 });
  }
  const tenant = params.tenant.trim();
  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!tenant || !claim) {
    return Response.json({ error: 'invalid' }, { status: 400 });
  }
  try {
    return Response.json(await fetchChatLog({ tenant, claim }));
  } catch {
    console.log('[api:admin] chatlog failed', { tenant });
    return Response.json({ error: 'upstream_error' }, { status: 502 });
  }
}
