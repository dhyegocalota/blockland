// Client-side tenant resolution. Picks the tenant id from `?tenant=` or the subdomain and
// fetches its branding from the data API (Rust-owned). There is no hardcoded fallback: if the
// tenant can't be loaded we surface the failure instead of silently masking it.
import { type Tenant } from './builtins';
import { debug, warn } from './log';

export { PLATFORM_NAME } from './builtins';
export type Brand = Tenant;

// The app's own root domain; tenants live on subdomains of it (acme.<ROOT_DOMAIN>). Defaults to
// localhost for dev (tenants are acme.localhost); set NEXT_PUBLIC_ROOT_DOMAIN in production. Knowing
// the root, a host is a tenant iff it ends with `.<ROOT_DOMAIN>` — no per-platform special cases.
// The tenant subdomain prefix for a host, or null when the host IS the app root (admin lives there).
// Pure, so the server (metadata, manifest) shares it with the client.
export function tenantSubdomainOf(host: string): string | null {
  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost';
  if (host === root || host === `www.${root}`) return null;
  if (host.endsWith(`.${root}`)) return host.slice(0, -(root.length + 1)).toLowerCase();
  return null;
}

// The app root domain for an arbitrary host: drop the tenant subdomain label so a host taken from a
// preview or prod request maps back to the indexable landing. Bare-localhost dev keeps its host
// (acme.localhost → localhost). Returns the host unchanged when it already IS the root.
export function rootDomainOf(host: string): string {
  const subdomain = tenantSubdomainOf(host);
  if (!subdomain) return host;
  return host.slice(subdomain.length + 1);
}

// The tenant for the current browser host (client-only; reads window).
export function tenantSubdomain(): string | null {
  return tenantSubdomainOf(window.location.hostname);
}

export function tenantIdFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('tenant');
  if (q) return q.toLowerCase();
  return tenantSubdomain();
}

export interface ResolvedTenant {
  tenant: Tenant;
  offline: boolean;
}

async function fetchOnlineTenant(id: string): Promise<Tenant | null> {
  try {
    const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) {
      warn('tenant', 'store returned non-ok', { id, status: res.status });
      return null;
    }
    return (await res.json()) as Tenant;
  } catch (error) {
    warn('tenant', 'store fetch threw', { id, error: String(error) });
    return null;
  }
}

async function fetchBundledTenant(): Promise<Tenant | null> {
  try {
    const res = await fetch('/tenant.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Tenant;
  } catch (error) {
    warn('tenant', 'bundled tenant fetch threw', { error: String(error) });
    return null;
  }
}

export async function resolveTenant(): Promise<ResolvedTenant> {
  const id = tenantIdFromLocation();
  if (!id) throw new Error('tenant_unresolved');
  debug('tenant', 'resolving', { id, host: window.location.hostname, search: window.location.search });

  const online = await fetchOnlineTenant(id);
  if (online) {
    debug('tenant', 'resolved from store', { id: online.id, name: online.name });
    return { tenant: online, offline: false };
  }

  const bundled = await fetchBundledTenant();
  if (bundled) {
    debug('tenant', 'resolved from bundled artifact (offline)', { id: bundled.id, name: bundled.name });
    return { tenant: bundled, offline: true };
  }

  throw new Error(`tenant_unavailable:${id}`);
}
