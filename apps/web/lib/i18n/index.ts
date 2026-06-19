// Tiny i18n runtime: resolves the active locale and looks up catalog messages.
import { DEFAULT_LOCALE, messages, type Locale } from './catalog';

function isLocale(value: string): value is Locale {
  return value in messages;
}

export function currentLocale(): Locale {
  // pt-BR is the default everywhere (server + client) so SSR and hydration agree; en-US is opt-in
  // via `?lang=en-US`. Auto-detecting navigator.language here would diverge from the server render
  // and break hydration.
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const lang = new URLSearchParams(window.location.search).get('lang');
  if (lang && isLocale(lang)) return lang;
  return DEFAULT_LOCALE;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = currentLocale();
  const localized = messages[locale][key];
  const fallback = messages[DEFAULT_LOCALE][key];
  const template = localized ?? fallback ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
