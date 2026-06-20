// Server-only Cloudflare Turnstile verification: confirms the widget token with Cloudflare before we
// trust a form submission. When TURNSTILE_SECRET_KEY is unset (local dev) it logs and passes, mirroring
// how the mailer degrades without RESEND_API_KEY so signups still work locally.
import 'server-only';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(params: {
  token: string;
  remoteIp: string | null;
}): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.log('[turnstile] dev (no TURNSTILE_SECRET_KEY): skipping verification');
    return true;
  }
  if (params.token.length === 0) return false;

  const form = new URLSearchParams({ secret, response: params.token });
  if (params.remoteIp) form.set('remoteip', params.remoteIp);

  const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
  if (!res.ok) return false;
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}
