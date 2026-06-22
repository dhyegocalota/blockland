// Tiny i18n runtime: resolves the active locale and looks up catalog messages.
// CLIENT path. The active locale comes from the URL prefix the middleware serves (/pt-br, /en-us),
// then the remembered `bl-locale` cookie, then the pt-BR default — so SSR and hydration agree.
// Server Components read the locale from the request header instead (see ./server).
import { DEFAULT_LOCALE, messages, type Locale } from './catalog';
import { LOCALE_COOKIE, isLocale, splitLocalePrefix } from './locale';

function cookieLocale(): Locale | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  if (!isLocale(value)) return null;
  return value;
}

export function currentLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const prefixed = splitLocalePrefix(window.location.pathname);
  if (prefixed) return prefixed.locale;
  const cookie = cookieLocale();
  if (cookie) return cookie;
  return DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const localized = messages[locale][key];
  const fallback = messages[DEFAULT_LOCALE][key];
  const template = localized ?? fallback ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(currentLocale(), key, vars);
}
