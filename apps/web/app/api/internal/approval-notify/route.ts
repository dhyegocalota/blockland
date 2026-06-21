// Internal endpoint the Rust server calls (HMAC-signed, same scheme as the Next -> Rust channel) when
// a player is held out by a tenant's approval gate. We verify the signature, then email each of the
// tenant's admins that someone is waiting. The web owns the mailer (Resend); the server does not.
import { verifyInternalSignature } from '../../../../lib/api';
import { sendMail } from '../../../../lib/mailer';
import { ApprovalRequestEmail } from '../../../../emails/ApprovalRequestEmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PATH = '/api/internal/approval-notify';

interface ApprovalNotice {
  tenant: string;
  name: string;
  emails: string[];
}

export async function POST(req: Request) {
  const ts = req.headers.get('x-bl-ts');
  const nonce = req.headers.get('x-bl-nonce');
  const signature = req.headers.get('x-bl-sig');
  if (!ts || !nonce || !signature) {
    return Response.json({ ok: false, error: 'unsigned' }, { status: 401 });
  }
  const body = await req.text();
  const verified = verifyInternalSignature({ method: 'POST', path: PATH, ts, nonce, signature, body });
  if (!verified) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let notice: ApprovalNotice;
  try {
    notice = JSON.parse(body) as ApprovalNotice;
  } catch {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }
  if (!notice.name || !notice.tenant || !Array.isArray(notice.emails)) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  await notify(notice);
  console.log('[api:approval-notify] sent', { tenant: notice.tenant, admins: notice.emails.length });
  return Response.json({ ok: true });
}

// A mail failure must not fail the response (the server still records the pending request and the
// admin can approve in-game) — log and move on.
async function notify(notice: ApprovalNotice): Promise<void> {
  try {
    await Promise.all(
      notice.emails.map((to) =>
        sendMail({
          to,
          subject: `A player is waiting to join ${notice.tenant} 🙋`,
          react: ApprovalRequestEmail({ name: notice.name, tenant: notice.tenant }),
        }),
      ),
    );
  } catch (err) {
    console.error('[api:approval-notify] notify failed', { tenant: notice.tenant, err });
  }
}
