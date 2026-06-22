// SERVER path for i18n: Server Components and generateMetadata read the active locale from the
// request header the middleware sets (x-bl-locale), falling back to the bl-locale cookie, then the
// pt-BR default. Kept separate from ./index so client bundles never import next/headers.
import { headers, cookies } from 'next/headers';
import { DEFAULT_LOCALE, type Locale } from './catalog';
import { translate } from './index';
import { LOCALE_COOKIE, LOCALE_HEADER, isLocale } from './locale';

export function serverLocale(): Locale {
  const headerValue = headers().get(LOCALE_HEADER);
  if (headerValue && isLocale(headerValue)) return headerValue;
  const cookieValue = cookies().get(LOCALE_COOKIE)?.value;
  if (cookieValue && isLocale(cookieValue)) return cookieValue;
  return DEFAULT_LOCALE;
}

export function serverT(key: string, vars?: Record<string, string | number>): string {
  return translate(serverLocale(), key, vars);
}
