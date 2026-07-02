// LGPD cookie-consent choice, remembered in the `bl-cookie-consent` cookie so the banner shows once and
// the decision survives a reload. `Accepted` opts into non-essential analytics; `Essential` keeps only
// the functional storage the game needs. A missing/unknown cookie means "not decided yet" (banner shows).
import { readCookie, writeCookie } from './cookie';
import { rootDomainOf } from './tenants';

export const COOKIE_CONSENT_KEY = 'bl-cookie-consent';

// Fired to reopen the banner from a "manage cookies" link, so a visitor can change or withdraw consent
// at any time (LGPD: revoking must be as easy as giving). CookieConsent listens; the links dispatch it.
export const COOKIE_SETTINGS_EVENT = 'bl-cookie-settings';

export enum CookieConsentChoice {
  Accepted = 'accepted',
  Essential = 'essential',
}

// Share the choice across every subdomain of the platform — the landing lives on the root, the games on
// tenant subdomains — so a parent accepts once. localhost/IP dev cannot scope a cookie to a domain, so
// there it stays host-only (undefined).
export function cookieDomainFor(hostname: string): string | undefined {
  const root = rootDomainOf(hostname);
  if (root === 'localhost' || root.endsWith('.localhost') || /^[\d.]+$/.test(root)) return undefined;
  return `.${root}`;
}

function sharedCookieDomain(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return cookieDomainFor(window.location.hostname);
}

export function loadCookieConsent(): CookieConsentChoice | null {
  const stored = readCookie(COOKIE_CONSENT_KEY);
  if (stored === CookieConsentChoice.Accepted) return CookieConsentChoice.Accepted;
  if (stored === CookieConsentChoice.Essential) return CookieConsentChoice.Essential;
  return null;
}

export function saveCookieConsent(choice: CookieConsentChoice): void {
  writeCookie(COOKIE_CONSENT_KEY, choice, { domain: sharedCookieDomain() });
}
