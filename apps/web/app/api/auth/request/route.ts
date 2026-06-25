// Start a login: prove ownership of a username within a tenant. Calls the Rust auth API to mint a
// magic-link token + 6-digit code, then emails them to the player. The token and code NEVER reach
// the browser — the response only says ok/error.
import { authRequest } from '../../../../lib/auth';
import { send } from '../../../../lib/mailer';
import { verifyTurnstile } from '../../../../lib/turnstile';
import { clientIp } from '../../../../lib/client-ip';
import { MagicLinkEmail } from '../../../../emails/MagicLinkEmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const tenant = String(body.tenant ?? '').trim();
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  // Email alone is enough to log in (the server resolves the account by email); a name is optional and
  // only needed to register a brand-new account.
  if (!tenant || !email) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  // This endpoint sends an email, so gate it behind Turnstile to stop someone spamming inboxes with
  // login codes. Same widget/verification as the waitlist; skipped in dev when no secret is configured.
  const turnstileToken = String(body.turnstileToken ?? '').trim();
  const human = await verifyTurnstile({ token: turnstileToken, remoteIp: clientIp(req) });
  if (!human) {
    return Response.json({ ok: false, error: 'turnstile' }, { status: 400 });
  }

  const result = await authRequest({ tenant, name, email });
  if (!result.ok) {
    console.log('[api:auth] request rejected', { tenant, error: result.error });
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  const magicLink = `${origin}/claim?token=${result.token}`;
  await send({
    to: result.email,
    subject: `${result.code} is your login code`,
    react: MagicLinkEmail({ name: result.name, code: result.code, magicLink }),
    devMagicLink: magicLink,
    devCode: result.code,
  });
  console.log('[api:auth] request sent', { tenant, name: result.name });
  return Response.json({ ok: true });
}
