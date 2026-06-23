'use client';

// Flag pill that flips the active locale: it rewrites the URL's locale prefix to the other locale,
// remembers the choice in the bl-locale cookie, and reloads so the whole tree (and server metadata)
// re-renders in the new language. On-theme with the lobby's blocky gold-haloed buttons.
import { type CSSProperties } from 'react';
import { currentLocale } from '../lib/i18n';
import { LOCALE_COOKIE, LOCALES, localePrefix, splitLocalePrefix, type Locale } from '../lib/i18n/locale';

const FLAGS: Record<Locale, string> = {
  'pt-BR': '🇧🇷',
  'en-US': '🇺🇸',
};

const LABELS: Record<Locale, string> = {
  'pt-BR': 'PT',
  'en-US': 'EN',
};

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function pathUnderLocale(locale: Locale): string {
  const { pathname, search } = window.location;
  const prefixed = splitLocalePrefix(pathname);
  const rest = prefixed ? prefixed.rest : pathname;
  const base = rest === '/' ? '' : rest;
  return `/${localePrefix(locale)}${base}${search}`;
}

export default function LocaleSwitcher() {
  const active = currentLocale();

  function switchTo(locale: Locale) {
    if (locale === active) return;
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    window.location.assign(pathUnderLocale(locale));
  }

  return (
    <div style={STYLES.wrap} role="group" aria-label="Language">
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          aria-label={LABELS[locale]}
          aria-pressed={locale === active}
          onClick={() => switchTo(locale)}
          style={locale === active ? STYLES.optionActive : STYLES.option}
        >
          <span aria-hidden>{FLAGS[locale]}</span>
        </button>
      ))}
    </div>
  );
}

const STYLES: Record<string, CSSProperties> = {
  wrap: {
    display: 'inline-flex',
    gap: 3,
    padding: 3,
    background: 'rgba(42, 26, 74, 0.85)',
    borderRadius: 999,
    border: '2px solid var(--gold)',
    pointerEvents: 'auto',
  },
  option: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 15,
    lineHeight: 1,
    background: 'transparent',
    border: 'none',
    borderRadius: 999,
    padding: '3px 7px',
    cursor: 'pointer',
  },
  optionActive: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 15,
    lineHeight: 1,
    background: 'var(--gold)',
    border: 'none',
    borderRadius: 999,
    padding: '3px 7px',
    cursor: 'default',
  },
};
