import { NextResponse, type NextRequest } from 'next/server';
import { tenantSubdomainOf } from './lib/tenants';
import { WELCOME_PATH, welcomeRedirectTarget } from './lib/seo';

const PERMANENT_REDIRECT = 308;

export function middleware(req: NextRequest) {
  const hostHeader = req.headers.get('host');
  if (!hostHeader) return NextResponse.next();
  const hostname = hostHeader.split(':')[0];
  const path = req.nextUrl.pathname;

  const redirectTarget = welcomeRedirectTarget({ host: hostname, path });
  if (redirectTarget) return NextResponse.redirect(redirectTarget, PERMANENT_REDIRECT);

  const isAppRoot = tenantSubdomainOf(hostname) === null;
  if (isAppRoot && path === '/') {
    return NextResponse.rewrite(new URL(WELCOME_PATH, req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
