import { NextResponse, type NextRequest } from 'next/server';
import { tenantSubdomainOf } from './lib/tenants';
import { WELCOME_PATH, welcomeRedirectTarget } from './lib/seo';
import {
  LOCALE_COOKIE,
  LOCALE_HEADER,
  localePrefix,
  preferredLocale,
  splitLocalePrefix,
  type Locale,
} from './lib/i18n/locale';

const PERMANENT_REDIRECT = 308;
const TEMPORARY_REDIRECT = 307;
const UNPREFIXED_PATHS = ['/claim'];

function isUnprefixed(path: string): boolean {
  return UNPREFIXED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function withLocaleCookie(res: NextResponse, locale: Locale): NextResponse {
  res.cookies.set(LOCALE_COOKIE, locale, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  return res;
}

// Serves the request under an unprefixed app route while remembering the active locale: the route
// tree stays free of a [locale] segment, and the locale travels to RSC via the x-bl-locale header
// (read by lib/i18n/server) and persists in the bl-locale cookie.
function rewriteToRoute({ req, locale, path }: { req: NextRequest; locale: Locale; path: string }): NextResponse {
  const url = new URL(path, req.url);
  const headers = new Headers(req.headers);
  headers.set(LOCALE_HEADER, locale);
  const res = NextResponse.rewrite(url, { request: { headers } });
  return withLocaleCookie(res, locale);
}

export function middleware(req: NextRequest) {
  const hostHeader = req.headers.get('host');
  if (!hostHeader) return NextResponse.next();
  const hostname = hostHeader.split(':')[0];
  const path = req.nextUrl.pathname;

  if (isUnprefixed(path)) return NextResponse.next();

  const prefixed = splitLocalePrefix(path);
  if (!prefixed) {
    const locale = preferredLocale({
      cookie: req.cookies.get(LOCALE_COOKIE)?.value ?? null,
      acceptLanguage: req.headers.get('accept-language'),
    });
    const target = new URL(`/${localePrefix(locale)}${path}`, req.url);
    target.search = req.nextUrl.search;
    return withLocaleCookie(NextResponse.redirect(target, TEMPORARY_REDIRECT), locale);
  }

  const { locale, rest } = prefixed;

  const redirectTarget = welcomeRedirectTarget({ host: hostname, path: rest });
  if (redirectTarget) {
    const target = new URL(redirectTarget);
    target.pathname = `/${localePrefix(locale)}`;
    return withLocaleCookie(NextResponse.redirect(target, PERMANENT_REDIRECT), locale);
  }

  const isAppRoot = tenantSubdomainOf(hostname) === null;
  if (isAppRoot && rest === '/') return rewriteToRoute({ req, locale, path: WELCOME_PATH });
  return rewriteToRoute({ req, locale, path: rest });
}

export const config = {
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
