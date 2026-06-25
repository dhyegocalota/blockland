// Client-side tenant resolution. Picks the tenant id from `?tenant=` or the subdomain and
// fetches its branding from the data API (Rust-owned). There is no hardcoded fallback: if the
// tenant can't be loaded we surface the failure instead of silently masking it.
import { type Tenant } from './builtins';
import { debug, warn } from './log';
import { type Connectivity, connectivityAfterFetch, loadCachedTenant, saveCachedTenant } from './tenant-cache';

export { PLATFORM_NAME } from './builtins';
export type { Connectivity } from './tenant-cache';
export { loadCachedTenant } from './tenant-cache';
export type Brand = Tenant;

// Cap the live tenant fetch so a hung connection (server unreachable) can't stall revalidation: the
// cached tenant already painted the lobby, so a slow API just resolves into the offline banner.
const TENANT_FETCH_TIMEOUT_MS = 6000;

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
  // 'online' when the live fetch answered; otherwise the lobby is running off the cached/bundled tenant
  // and `connectivity` says whether the SERVER is down or the USER has no internet.
  connectivity: Connectivity;
}

async function fetchOnlineTenant(id: string): Promise<Tenant | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TENANT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`, { cache: 'no-store', signal: abort.signal });
    if (!res.ok) {
      warn('tenant', 'store returned non-ok', { id, status: res.status });
      return null;
    }
    return (await res.json()) as Tenant;
  } catch (error) {
    warn('tenant', 'store fetch threw', { id, error: String(error) });
    return null;
  } finally {
    clearTimeout(timer);
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
    saveCachedTenant(online);
    return { tenant: online, connectivity: 'online' };
  }

  // The live fetch failed: serve the last-known tenant (the localStorage cache, then the bundled
  // artifact) so the lobby still works, and report WHY it's degraded — server down vs no internet.
  let fallback = loadCachedTenant(id);
  if (!fallback) fallback = await fetchBundledTenant();
  if (fallback) {
    // Default to "online" unless the browser explicitly reports the network is down (onLine === false),
    // so a runtime without a real navigator reads as server_down (the server, not the user, is the issue).
    const navigatorOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
    const connectivity = connectivityAfterFetch({ fetched: false, navigatorOnline });
    debug('tenant', 'resolved from cache/bundled (degraded)', { id: fallback.id, connectivity });
    return { tenant: fallback, connectivity };
  }

  throw new Error(`tenant_unavailable:${id}`);
}
