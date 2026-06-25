// Pre-launch waitlist capture for the /welcome offer page. Verifies the Cloudflare Turnstile token,
// validates the email, normalizes the optional name/WhatsApp to null when blank, persists through the
// signed internal API, then notifies the parent (confirmation) and the admin (new-lead notice). The
// HMAC token, nonce and signature never reach the browser — the response only says ok/error.
import { isConsentGiven, isValidEmail, joinWaitlist } from '../../../lib/waitlist';
import { verifyTurnstile } from '../../../lib/turnstile';
import { clientIp } from '../../../lib/client-ip';
import { sendMail } from '../../../lib/mailer';
import { WaitlistConfirmationEmail } from '../../../emails/WaitlistConfirmationEmail';
import { WaitlistNotificationEmail } from '../../../emails/WaitlistNotificationEmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  const token = String(body.turnstileToken ?? '').trim();
  const human = await verifyTurnstile({ token, remoteIp: clientIp(req) });
  if (!human) {
    return Response.json({ ok: false, error: 'turnstile' }, { status: 400 });
  }

  if (!isConsentGiven(body.consent)) {
    return Response.json({ ok: false, error: 'consent' }, { status: 400 });
  }

  const email = String(body.email ?? '').trim();
  if (!isValidEmail(email)) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  }

  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const name = rawName.length > 0 ? rawName : null;
  const phone = rawPhone.length > 0 ? rawPhone : null;

  await joinWaitlist({ email, name, phone });
  console.log('[api:waitlist] joined', { email });
  await notify({ email, name, phone });

  return Response.json({ ok: true });
}

// The lead is already saved, so a mail failure must not fail the response — log and move on.
async function notify(entry: { email: string; name: string | null; phone: string | null }): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  try {
    await sendMail({
      to: entry.email,
      subject: 'Sua vaga no Blockland está reservada 🎉',
      react: WaitlistConfirmationEmail({ name: entry.name }),
    });
    if (!adminEmail) return;
    await sendMail({
      to: adminEmail,
      subject: `New Blockland waitlist signup: ${entry.email}`,
      react: WaitlistNotificationEmail(entry),
    });
  } catch (err) {
    console.error('[api:waitlist] notify failed', { email: entry.email, err });
  }
}
