// Tiny i18n runtime: resolves the active locale and looks up catalog messages.
import { DEFAULT_LOCALE, messages } from './catalog';

export function currentLocale() {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const lang = new URLSearchParams(window.location.search).get('lang');
  if (lang && messages[lang]) return lang;
  if (navigator.language && navigator.language.startsWith('pt')) return 'pt-BR';
  return 'en-US';
}

export function t(key, vars) {
  const locale = currentLocale();
  const localized = messages[locale][key];
  const fallback = messages[DEFAULT_LOCALE][key];
  const template = localized ?? fallback ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
