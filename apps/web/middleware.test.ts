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
    expect(rewrittenTo(request({ host: `teo.${PROD_ROOT}`, path: '/' }))).toBeNull();
  });

  it('serves the game at / on a localhost tenant subdomain (no rewrite)', () => {
    expect(rewrittenTo(request({ host: 'teo.localhost', path: '/' }))).toBeNull();
  });

  it('ignores the port in the host when classifying a tenant subdomain', () => {
    expect(rewrittenTo(request({ host: 'teo.localhost:3099', path: '/' }))).toBeNull();
  });

  it('ignores the port in the host on the app root', () => {
    expect(rewrittenTo(request({ host: 'localhost:3099', path: '/' }))).toContain('/welcome');
  });

  it('leaves non-root paths on the app root untouched', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rewrittenTo(request({ host: PROD_ROOT, path: '/admin' }))).toBeNull();
  });
});
