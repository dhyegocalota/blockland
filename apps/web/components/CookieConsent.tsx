'use client';

// LGPD cookie-consent banner shown site-wide (landing + game lobby) until the visitor decides. "Accept
// all" opts into non-essential analytics — which is why <Analytics/> lives here and only mounts on that
// choice; "Essential only" keeps just the functional storage the game needs. The decision is remembered
// in the bl-cookie-consent cookie, so the bar shows once. On-theme with the lobby's gold-haloed pills.
import { type CSSProperties, useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/next';
import { t } from '../lib/i18n';
import { CookieConsentChoice, loadCookieConsent, saveCookieConsent } from '../lib/cookie-consent';

export default function CookieConsent() {
  const [choice, setChoice] = useState<CookieConsentChoice | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setChoice(loadCookieConsent());
    setMounted(true);
  }, []);

  function decide(next: CookieConsentChoice): void {
    saveCookieConsent(next);
    setChoice(next);
  }

  const [beforeLink, afterLink] = t('cookie.message').split('{privacy}');

  return (
    <>
      {choice === CookieConsentChoice.Accepted && <Analytics />}
      {mounted && choice === null && (
        <div style={STYLES.bar} role="region" aria-label="Cookie consent">
          <p style={STYLES.text}>
            {beforeLink}
            <a style={STYLES.link} href="/privacy">{t('cookie.privacy_link')}</a>
            {afterLink}
          </p>
          <div style={STYLES.actions}>
            <button style={STYLES.accept} type="button" onClick={() => decide(CookieConsentChoice.Accepted)}>
              {t('cookie.accept')}
            </button>
            <button style={STYLES.essential} type="button" onClick={() => decide(CookieConsentChoice.Essential)}>
              {t('cookie.essential')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const STYLES: Record<string, CSSProperties> = {
  bar: {
    position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 3000,
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 12,
    margin: '0 auto', maxWidth: 720, padding: '12px 16px',
    background: 'rgba(42, 26, 74, 0.94)', borderRadius: 18, border: '2px solid var(--gold)',
    boxShadow: '0 12px 32px #0005',
    fontFamily: "'Comic Sans MS', system-ui, sans-serif", color: '#fff',
  },
  text: { flex: '1 1 260px', margin: 0, fontSize: 13, fontWeight: 700, lineHeight: 1.5 },
  link: { color: 'var(--gold)', fontWeight: 800, textDecoration: 'underline' },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  accept: {
    background: '#ff5d2e', color: '#fff', border: 'none', borderRadius: 999, cursor: 'pointer',
    padding: '8px 16px', fontSize: 14, fontWeight: 800, fontFamily: 'inherit',
  },
  essential: {
    background: 'transparent', color: '#fff', border: '2px solid var(--gold)', borderRadius: 999,
    cursor: 'pointer', padding: '6px 14px', fontSize: 14, fontWeight: 800, fontFamily: 'inherit',
  },
};
