import { NextResponse, type NextRequest } from 'next/server';
import { tenantSubdomainOf } from './lib/tenants';

export function middleware(req: NextRequest) {
  const hostHeader = req.headers.get('host');
  if (!hostHeader) return NextResponse.next();
  const hostname = hostHeader.split(':')[0];
  const isAppRoot = tenantSubdomainOf(hostname) === null;
  if (isAppRoot && req.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL('/welcome', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|api|.*\\..*).*)'],
};
