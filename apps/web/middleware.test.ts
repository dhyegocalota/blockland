import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const PROD_ROOT = 'blockland.dhyegocalota.com.br';

function request({
  host,
  path,
  cookie,
  acceptLanguage,
}: {
  host: string;
  path: string;
  cookie?: string;
  acceptLanguage?: string;
}): NextRequest {
  const headers: Record<string, string> = { host };
  if (cookie) headers.cookie = cookie;
  if (acceptLanguage) headers['accept-language'] = acceptLanguage;
  return new NextRequest(`https://${host}${path}`, { headers });
}

function rewrittenTo(req: NextRequest): string | null {
  const res = middleware(req);
  return res.headers.get('x-middleware-rewrite');
}

function localeHeaderOf(req: NextRequest): string | null {
  const res = middleware(req);
  return res.headers.get('x-middleware-request-x-bl-locale');
}

function redirect(req: NextRequest): { status: number; location: string | null } {
  const res = middleware(req);
  return { status: res.status, location: res.headers.get('location') };
}

function cookieOf(req: NextRequest): string | undefined {
  return middleware(req).cookies.get('bl-locale')?.value;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('middleware locale prefixing', () => {
  it('redirects an unprefixed path to the cookie locale when set', () => {
    const res = redirect(request({ host: 'localhost', path: '/welcome', cookie: 'bl-locale=en-US' }));
    expect(res.status).toBe(307);
    expect(res.location).toBe('https://localhost/en-us/welcome');
  });

  it('redirects an unprefixed path to the Accept-Language locale when no cookie', () => {
    const res = redirect(request({ host: 'localhost', path: '/welcome', acceptLanguage: 'en-US,en;q=0.9' }));
    expect(res.location).toBe('https://localhost/en-us/welcome');
  });

  it('redirects to the pt-BR default when no cookie and no usable Accept-Language', () => {
    const res = redirect(request({ host: 'localhost', path: '/admin' }));
    expect(res.location).toBe('https://localhost/pt-br/admin');
  });

  it('preserves the query string on the locale redirect', () => {
    const res = redirect(request({ host: 'localhost', path: '/claim-test?tenant=acme', cookie: 'bl-locale=pt-BR' }));
    expect(res.location).toBe('https://localhost/pt-br/claim-test?tenant=acme');
  });

  it('persists the chosen locale in the bl-locale cookie on redirect', () => {
    expect(cookieOf(request({ host: 'localhost', path: '/welcome', acceptLanguage: 'en' }))).toBe('en-US');
  });

  it('leaves the claim route unprefixed (no redirect, no rewrite)', () => {
    const res = middleware(request({ host: 'localhost', path: '/claim' }));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });
});

describe('middleware rewrite (prefixed paths)', () => {
  it('rewrites the app root /pt-br to /welcome', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: PROD_ROOT, path: '/pt-br' }))).toContain('/welcome');
  });

  it('rewrites bare localhost /en-us to /welcome', () => {
    expect(rewrittenTo(request({ host: 'localhost', path: '/en-us' }))).toContain('/welcome');
  });

  it('sets the locale request header from the URL prefix', () => {
    expect(localeHeaderOf(request({ host: 'localhost', path: '/en-us' }))).toBe('en-US');
    expect(localeHeaderOf(request({ host: 'localhost', path: '/pt-br/admin' }))).toBe('pt-BR');
  });

  it('serves the game at /pt-br on a tenant subdomain (rewrite to /)', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: `acme.${PROD_ROOT}`, path: '/pt-br' }))).toMatch(/\/$/);
  });

  it('serves the game at /en-us on a localhost tenant subdomain (rewrite to /)', () => {
    expect(rewrittenTo(request({ host: 'acme.localhost', path: '/en-us' }))).toMatch(/\/$/);
  });

  it('ignores the port in the host when classifying a tenant subdomain', () => {
    expect(rewrittenTo(request({ host: 'acme.localhost:3099', path: '/pt-br' }))).toMatch(/\/$/);
  });

  it('rewrites a prefixed non-root path on the app root to its unprefixed route', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: PROD_ROOT, path: '/pt-br/admin' }))).toContain('/admin');
  });
});

describe('middleware welcome redirect (tenant subdomain)', () => {
  it('308-redirects a tenant subdomain hitting /pt-br/welcome to the localized root home', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(redirect(request({ host: `acme.${PROD_ROOT}`, path: '/pt-br/welcome' }))).toEqual({
      status: 308,
      location: `https://${PROD_ROOT}/pt-br`,
    });
  });

  it('308-redirects a localhost tenant on /en-us/welcome to the bare localhost root home', () => {
    expect(redirect(request({ host: 'acme.localhost', path: '/en-us/welcome' }))).toEqual({
      status: 308,
      location: 'http://localhost/en-us',
    });
  });

  it('serves /pt-br/welcome on the app root (no redirect)', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(redirect(request({ host: PROD_ROOT, path: '/pt-br/welcome' })).location).toBeNull();
  });
});
