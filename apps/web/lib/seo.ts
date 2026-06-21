// Pure SEO/redirect decisions keyed off the request host + path. The landing lives ONLY on the app
// root: a tenant subdomain serving it is a duplicate, so we 308 it to the root and mark every tenant
// page noindex with a canonical pointing at the root. The root stays indexable with its own canonical.
import { rootDomainOf, tenantSubdomainOf } from './tenants';

export const WELCOME_PATH = '/welcome';
export const ROBOTS_NOINDEX = 'noindex, nofollow';

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
