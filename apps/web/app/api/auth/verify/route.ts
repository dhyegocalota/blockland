// Verify ownership: either a magic-link token or a typed (tenant, name, code). On success the Rust
// server returns a fresh claim token (the single live session for that tenant+name), revoking any
// previous holder. The claim is returned to the browser to store in bl-session.
import { authVerifyToken, authVerifyCode } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (token) {
    const result = await authVerifyToken(token);
    return Response.json(result);
  }

  const tenant = String(body.tenant ?? '').trim();
  const name = String(body.name ?? '').trim();
  const code = String(body.code ?? '').trim();
  if (!tenant || !name || !code) {
    return Response.json({ ok: false }, { status: 400 });
  }
  const result = await authVerifyCode({ tenant, name, code });
  return Response.json(result);
}
