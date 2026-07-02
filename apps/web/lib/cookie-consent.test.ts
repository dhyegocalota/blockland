// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { COOKIE_CONSENT_KEY, CookieConsentChoice, loadCookieConsent, saveCookieConsent } from './cookie-consent';

afterEach(() => { document.cookie = `${COOKIE_CONSENT_KEY}=; path=/; max-age=0`; });

describe('cookie-consent', () => {
  it('returns null before any choice is made', () => {
    expect(loadCookieConsent()).toBeNull();
  });

  it('remembers an accepted choice', () => {
    saveCookieConsent(CookieConsentChoice.Accepted);
    expect(loadCookieConsent()).toBe(CookieConsentChoice.Accepted);
  });

  it('remembers an essential-only choice', () => {
    saveCookieConsent(CookieConsentChoice.Essential);
    expect(loadCookieConsent()).toBe(CookieConsentChoice.Essential);
  });

  it('treats an unknown stored value as undecided', () => {
    document.cookie = `${COOKIE_CONSENT_KEY}=whatever; path=/`;
    expect(loadCookieConsent()).toBeNull();
  });
});
