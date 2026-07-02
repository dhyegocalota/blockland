// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_CONSENT_KEY, CookieConsentChoice, cookieDomainFor, loadCookieConsent, saveCookieConsent } from './cookie-consent';

afterEach(() => { document.cookie = `${COOKIE_CONSENT_KEY}=; path=/; max-age=0`; vi.unstubAllEnvs(); });

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

describe('cookieDomainFor', () => {
  it('scopes the choice to the platform root so every subdomain shares it', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'blockland.dhyegocalota.com.br');
    expect(cookieDomainFor('demo.blockland.dhyegocalota.com.br')).toBe('.blockland.dhyegocalota.com.br');
    expect(cookieDomainFor('blockland.dhyegocalota.com.br')).toBe('.blockland.dhyegocalota.com.br');
  });

  it('stays host-only on localhost/IP dev where a cookie domain cannot be set', () => {
    expect(cookieDomainFor('acme.localhost')).toBeUndefined();
    expect(cookieDomainFor('localhost')).toBeUndefined();
    expect(cookieDomainFor('127.0.0.1')).toBeUndefined();
  });
});
