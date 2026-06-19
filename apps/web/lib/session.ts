// Browser-side login session. A claim token is the single live (tenant, name) session; we store it
// in localStorage so the game can re-send it on Join. The claim is only valid for the exact tenant
// and name it was issued for — a stored session for a different tenant/name must not leak its claim.
export const SESSION_KEY = 'bl-session';

export interface Session {
  tenant: string;
  name: string;
  claim: string;
}

export function loadSession(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.tenant || !parsed.name || !parsed.claim) return null;
    return { tenant: parsed.tenant, name: parsed.name, claim: parsed.claim };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SESSION_KEY);
}

// The claim that proves ownership of `name` in `tenant`, or '' when no matching session exists.
export function resolveClaim(tenant: string, name: string): string {
  const session = loadSession();
  if (!session) return '';
  if (session.tenant !== tenant) return '';
  if (session.name !== name) return '';
  return session.claim;
}
