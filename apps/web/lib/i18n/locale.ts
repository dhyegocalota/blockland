// Pure locale resolution shared by the middleware (request) and the runtime (t()): URL prefix,
// cookie and Accept-Language are the three real sources; pt-BR is the defined default (not a silent
// mask) when none of them name a supported locale.
import { DEFAULT_LOCALE, messages, type Locale } from './catalog';

export type { Locale };

export const LOCALE_COOKIE = 'bl-locale';
export const LOCALE_HEADER = 'x-bl-locale';

const PREFIXES: Record<Locale, string> = {
  'pt-BR': 'pt-br',
  'en-US': 'en-us',
};

export const LOCALES = Object.keys(messages) as Locale[];

export function isLocale(value: string): value is Locale {
  return value in messages;
}

export function localePrefix(locale: Locale): string {
  return PREFIXES[locale];
}

export function localeOfPrefix(prefix: string): Locale | null {
  const match = LOCALES.find((locale) => PREFIXES[locale] === prefix.toLowerCase());
  if (!match) return null;
  return match;
}

export interface PrefixedPath {
  locale: Locale;
  rest: string;
}

// Splits "/en-us/admin" into { locale: 'en-US', rest: '/admin' }; returns null when the first path
// segment is not a known locale prefix.
export function splitLocalePrefix(pathname: string): PrefixedPath | null {
  const segments = pathname.split('/');
  const first = segments[1];
  if (!first) return null;
  const locale = localeOfPrefix(first);
  if (!locale) return null;
  const rest = '/' + segments.slice(2).join('/');
  return { locale, rest };
}

// Picks the best supported locale from an Accept-Language header; pt-BR wins ties and is the
// defined default when the header is empty or names only unsupported languages.
export function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE;
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, quality] = part.trim().split(';q=');
      return { tag: tag.toLowerCase(), quality: quality ? Number(quality) : 1 };
    })
    .sort((a, b) => b.quality - a.quality);
  const match = tags.find(({ tag }) => tag.startsWith('en') || tag.startsWith('pt'));
  if (!match) return DEFAULT_LOCALE;
  if (match.tag.startsWith('en')) return 'en-US';
  return DEFAULT_LOCALE;
}

// The locale the middleware should serve when a request carries no prefix: cookie first (the
// remembered choice), then Accept-Language, then the pt-BR default.
export function preferredLocale({
  cookie,
  acceptLanguage,
}: {
  cookie: string | null;
  acceptLanguage: string | null;
}): Locale {
  if (cookie && isLocale(cookie)) return cookie;
  return localeFromAcceptLanguage(acceptLanguage);
}
