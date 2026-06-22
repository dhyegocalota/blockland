// Server-only client for the internal waitlist route. Reuses the HMAC signer in api.ts so the
// browser never reaches the backend directly. A parent joins the pre-launch list with an email and,
// optionally, a display name and WhatsApp number (both modeled as nullable, never blank-defaulted).
import 'server-only';
import { signedFetch } from './api';

const EMAIL_MAX_LENGTH = 254;

export interface WaitlistEntry {
  email: string;
  name: string | null;
  phone: string | null;
}

// Structural email check mirroring the server's: a single local part and a dotted domain with no
// trailing dot. Kept deliberately permissive — the real proof of an address is the follow-up email.
export function isValidEmail(raw: string): boolean {
  const email = raw.trim();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  if (dot <= 0 || dot >= domain.length - 1) return false;
  return true;
}

// Verifiable parental consent gate: the parent must affirmatively agree (a checked box posts `true`)
// before we capture their contact data. Anything other than a literal `true` is treated as no consent.
export function isConsentGiven(value: unknown): boolean {
  return value === true;
}

export async function joinWaitlist(entry: WaitlistEntry): Promise<void> {
  const res = await signedFetch('POST', '/internal/waitlist', entry);
  if (!res.ok) throw new Error(`waitlist: join failed (${res.status})`);
}
