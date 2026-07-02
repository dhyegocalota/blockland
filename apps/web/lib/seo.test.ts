import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_LEGAL_NAME, landingJsonLd, robotsCanonicalFor, rootHomeUrl, welcomeRedirectTarget } from './seo';

const PROD_ROOT = 'blockland.dhyegocalota.com.br';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rootHomeUrl', () => {
  it('keeps the root host on production and uses https', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rootHomeUrl(PROD_ROOT)).toBe(`https://${PROD_ROOT}/`);
  });

  it('strips the tenant subdomain back to the root on production', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(rootHomeUrl(`acme.${PROD_ROOT}`)).toBe(`https://${PROD_ROOT}/`);
  });

  it('strips a localhost tenant to bare localhost over http', () => {
    expect(rootHomeUrl('acme.localhost')).toBe('http://localhost/');
  });

  it('keeps bare localhost over http', () => {
    expect(rootHomeUrl('localhost')).toBe('http://localhost/');
  });
});

describe('welcomeRedirectTarget', () => {
  it('redirects a tenant subdomain hitting /welcome to the root home', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(welcomeRedirectTarget({ host: `acme.${PROD_ROOT}`, path: '/welcome' })).toBe(`https://${PROD_ROOT}/`);
  });

  it('redirects a localhost tenant hitting /welcome to bare localhost', () => {
    expect(welcomeRedirectTarget({ host: 'acme.localhost', path: '/welcome' })).toBe('http://localhost/');
  });

  it('does not redirect the root host on /welcome', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(welcomeRedirectTarget({ host: PROD_ROOT, path: '/welcome' })).toBeNull();
  });

  it('does not redirect a tenant subdomain on other paths', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(welcomeRedirectTarget({ host: `acme.${PROD_ROOT}`, path: '/' })).toBeNull();
  });
});

describe('robotsCanonicalFor', () => {
  it('marks a tenant subdomain noindex with a canonical to the root', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(robotsCanonicalFor(`acme.${PROD_ROOT}`)).toEqual({
      noindex: true,
      canonical: `https://${PROD_ROOT}/`,
    });
  });

  it('keeps the root host indexable, canonical to itself', () => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', PROD_ROOT);
    expect(robotsCanonicalFor(PROD_ROOT)).toEqual({
      noindex: false,
      canonical: `https://${PROD_ROOT}/`,
    });
  });

  it('marks a localhost tenant noindex with a canonical to bare localhost', () => {
    expect(robotsCanonicalFor('acme.localhost')).toEqual({
      noindex: true,
      canonical: 'http://localhost/',
    });
  });
});

describe('landingJsonLd', () => {
  const rootUrl = `https://${PROD_ROOT}/`;
  const graph = landingJsonLd({ rootUrl, description: 'Voxel worlds for kids.' })['@graph'];

  it('describes the operator, the site and the product', () => {
    expect(graph.map((node) => node['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication']);
  });

  it('points the organization at the platform logo and legal name', () => {
    const organization = graph[0];
    expect(organization.legalName).toBe(COMPANY_LEGAL_NAME);
    expect(organization.logo).toBe(`${rootUrl}icons/icon-512.png`);
  });

  it('marks the product as a browser game for young children', () => {
    const application = graph[2];
    expect(application.applicationCategory).toBe('GameApplication');
    expect(application.audience).toEqual({ '@type': 'PeopleAudience', suggestedMinAge: 4 });
    expect(application.description).toBe('Voxel worlds for kids.');
  });
});
