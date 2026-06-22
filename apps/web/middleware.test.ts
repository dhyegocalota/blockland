import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const PROD_ROOT = 'blockland.dhyegocalota.com.br';

function request({ host, path }: { host: string; path: string }): NextRequest {
  return new NextRequest(`https://${host}${path}`, { headers: { host } });
}

function rewrittenTo(req: NextRequest): string | null {
  const res = middleware(req);
  return res.headers.get('x-middleware-rewrite');
}

function redirect(req: NextRequest): { status: number; location: string | null } {
  const res = middleware(req);
  return { status: res.status, location: res.headers.get('location') };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('middleware', () => {
  it('rewrites the app root / to /welcome', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: PROD_ROOT, path: '/' }))).toContain('/welcome');
  });

  it('rewrites bare localhost / to /welcome', () => {
    expect(rewrittenTo(request({ host: 'localhost', path: '/' }))).toContain('/welcome');
  });

  it('serves the game at / on a tenant subdomain (no rewrite)', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: `acme.${PROD_ROOT}`, path: '/' }))).toBeNull();
  });

  it('serves the game at / on a localhost tenant subdomain (no rewrite)', () => {
    expect(rewrittenTo(request({ host: 'acme.localhost', path: '/' }))).toBeNull();
  });

  it('ignores the port in the host when classifying a tenant subdomain', () => {
    expect(rewrittenTo(request({ host: 'acme.localhost:3099', path: '/' }))).toBeNull();
  });

  it('ignores the port in the host on the app root', () => {
    expect(rewrittenTo(request({ host: 'localhost:3099', path: '/' }))).toContain('/welcome');
  });

  it('leaves non-root paths on the app root untouched', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: PROD_ROOT, path: '/admin' }))).toBeNull();
  });

  it('308-redirects a tenant subdomain hitting /welcome to the root home', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(redirect(request({ host: `acme.${PROD_ROOT}`, path: '/welcome' }))).toEqual({
      status: 308,
      location: `https://${PROD_ROOT}/`,
    });
  });

  it('308-redirects a localhost tenant on /welcome to bare localhost', () => {
    expect(redirect(request({ host: 'acme.localhost', path: '/welcome' }))).toEqual({
      status: 308,
      location: 'http://localhost/',
    });
  });

  it('serves /welcome on the app root (no redirect)', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(redirect(request({ host: PROD_ROOT, path: '/welcome' })).location).toBeNull();
  });
});
