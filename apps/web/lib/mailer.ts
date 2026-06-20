// Email sender. When RESEND_API_KEY is set it renders the React Email template and sends through
// Resend (from MAIL_FROM); otherwise it logs the subject + magic-link URL + code so local dev can
// "receive" the email from the console. Never throws when unconfigured — login still works in dev.
import 'server-only';
import type { ReactElement } from 'react';
import { render } from '@react-email/render';
import { Resend } from 'resend';

function mailFrom(): string {
  const value = process.env.MAIL_FROM;
  if (!value) throw new Error('mailer: MAIL_FROM is not set');
  return value;
}

export async function send(params: {
  to: string;
  subject: string;
  react: ReactElement;
  devMagicLink: string;
  devCode: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[mailer] dev (no RESEND_API_KEY)', {
      to: params.to,
      subject: params.subject,
      magicLink: params.devMagicLink,
      code: params.devCode,
    });
    return;
  }
  await deliver({ apiKey, to: params.to, subject: params.subject, react: params.react });
}

// Generic transactional send (waitlist confirmation + admin notice). Same dev fallback as `send`:
// without RESEND_API_KEY it logs instead of sending, so local signups never fail on email.
export async function sendMail(params: {
  to: string;
  subject: string;
  react: ReactElement;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[mailer] dev (no RESEND_API_KEY)', { to: params.to, subject: params.subject });
    return;
  }
  await deliver({ apiKey, to: params.to, subject: params.subject, react: params.react });
}

async function deliver(params: {
  apiKey: string;
  to: string;
  subject: string;
  react: ReactElement;
}): Promise<void> {
  const html = await render(params.react);
  const resend = new Resend(params.apiKey);
  await resend.emails.send({ from: mailFrom(), to: params.to, subject: params.subject, html });
}
