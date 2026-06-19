// Tiny i18n runtime: resolves the active locale and looks up catalog messages.
import { DEFAULT_LOCALE, messages, type Locale } from './catalog';

function isLocale(value: string): value is Locale {
  return value in messages;
}

export function currentLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const lang = new URLSearchParams(window.location.search).get('lang');
  if (lang && isLocale(lang)) return lang;
  if (navigator.language && navigator.language.startsWith('pt')) return 'pt-BR';
  return 'en-US';
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = currentLocale();
  const localized = messages[locale][key];
  const fallback = messages[DEFAULT_LOCALE][key];
  const template = localized ?? fallback ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
