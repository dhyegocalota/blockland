// LGPD cookie-consent choice, remembered in the `bl-cookie-consent` cookie so the banner shows once and
// the decision survives a reload. `Accepted` opts into non-essential analytics; `Essential` keeps only
// the functional storage the game needs. A missing/unknown cookie means "not decided yet" (banner shows).
import { readCookie, writeCookie } from './cookie';

export const COOKIE_CONSENT_KEY = 'bl-cookie-consent';

export enum CookieConsentChoice {
  Accepted = 'accepted',
  Essential = 'essential',
}

export function loadCookieConsent(): CookieConsentChoice | null {
  const stored = readCookie(COOKIE_CONSENT_KEY);
  if (stored === CookieConsentChoice.Accepted) return CookieConsentChoice.Accepted;
  if (stored === CookieConsentChoice.Essential) return CookieConsentChoice.Essential;
  return null;
}

export function saveCookieConsent(choice: CookieConsentChoice): void {
  writeCookie(COOKIE_CONSENT_KEY, choice);
}
