// Pure SEO/redirect decisions keyed off the request host + path. The landing lives ONLY on the app
// root: a tenant subdomain serving it is a duplicate, so we 308 it to the root and mark every tenant
// page noindex with a canonical pointing at the root. The root stays indexable with its own canonical.
import { rootDomainOf, tenantSubdomainOf } from './tenants';
import { PLATFORM_NAME } from './builtins';

export const WELCOME_PATH = '/welcome';
export const ROBOTS_NOINDEX = 'noindex, nofollow';

// The operator behind the platform + where it is based (used for structured data and geo meta tags).
// Mirrors the company block shown on /terms and /privacy.
export const COMPANY_LEGAL_NAME = 'Logic Bit';
export const COMPANY_EMAIL = 'legal@logicbit.com.br';
export const GEO = {
  region: 'BR-MG',
  placename: 'Belo Horizonte',
  latitude: -19.9245,
  longitude: -43.9352,
} as const;

// Bare-localhost dev has no TLS; everything else is https.
function schemeFor(host: string): string {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'http';
  return 'https';
}

export function rootHomeUrl(host: string): string {
  const root = rootDomainOf(host);
  return `${schemeFor(host)}://${root}/`;
}

// A tenant subdomain hitting the landing must permanently redirect to the root home.
export function welcomeRedirectTarget({ host, path }: { host: string; path: string }): string | null {
  if (path !== WELCOME_PATH) return null;
  if (!tenantSubdomainOf(host)) return null;
  return rootHomeUrl(host);
}

export interface RobotsCanonical {
  noindex: boolean;
  canonical: string;
}

// Tenant subdomains are noindex with a canonical to the root; the root is indexable, canonical to self.
export function robotsCanonicalFor(host: string): RobotsCanonical {
  const isTenant = Boolean(tenantSubdomainOf(host));
  return { noindex: isTenant, canonical: rootHomeUrl(host) };
}

// schema.org structured data for the parent-facing landing: the operator (Organization), the site
// (WebSite) and the product itself (a browser GameApplication for kids). `rootUrl` ends with a slash
// (rootHomeUrl), so relative assets append cleanly. Serialized into a ld+json script by the layout.
export interface LandingJsonLd {
  '@context': string;
  '@graph': Array<Record<string, unknown>>;
}

export function landingJsonLd({ rootUrl, description }: { rootUrl: string; description: string }): LandingJsonLd {
  const organizationId = `${rootUrl}#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId,
        name: PLATFORM_NAME,
        legalName: COMPANY_LEGAL_NAME,
        url: rootUrl,
        logo: `${rootUrl}icons/icon-512.png`,
        email: COMPANY_EMAIL,
        address: {
          '@type': 'PostalAddress',
          addressLocality: GEO.placename,
          addressRegion: 'MG',
          addressCountry: 'BR',
        },
      },
      {
        '@type': 'WebSite',
        '@id': `${rootUrl}#website`,
        name: PLATFORM_NAME,
        url: rootUrl,
        inLanguage: ['pt-BR', 'en-US'],
        publisher: { '@id': organizationId },
      },
      {
        '@type': 'SoftwareApplication',
        name: PLATFORM_NAME,
        applicationCategory: 'GameApplication',
        operatingSystem: 'Web Browser',
        url: rootUrl,
        description,
        inLanguage: ['pt-BR', 'en-US'],
        audience: { '@type': 'PeopleAudience', suggestedMinAge: 4 },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'BRL' },
        publisher: { '@id': organizationId },
      },
    ],
  };
}
