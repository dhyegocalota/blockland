// Client-side tenant resolution. Picks the tenant id from `?tenant=` or the subdomain and
// fetches its branding from the data API (Rust-owned). There is no hardcoded fallback: if the
// tenant can't be loaded we surface the failure instead of silently masking it.
import { DEFAULT_TENANT, type Tenant } from './builtins';
import { debug, warn } from './log';

export { PLATFORM_NAME } from './builtins';
export type Brand = Tenant;

export function tenantIdFromLocation(): string {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('tenant');
  if (q) return q.toLowerCase();

  const host = window.location.hostname;
  const parts = host.split('.');
  const first = parts[0];
  const isSubdomain =
    parts.length >= 2 &&
    !['www', 'localhost'].includes(first) &&
    !host.endsWith('.vercel.app'); // preview/default domains aren't tenant subdomains
  if (isSubdomain) return first.toLowerCase();

  return DEFAULT_TENANT;
}

export async function resolveTenant(): Promise<Tenant> {
  const id = tenantIdFromLocation();
  debug('tenant', 'resolving', { id, host: window.location.hostname, search: window.location.search });
  const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) {
    warn('tenant', 'store returned non-ok', { id, status: res.status });
    throw new Error(`tenant_unavailable:${id}`);
  }
  const tenant = (await res.json()) as Tenant;
  debug('tenant', 'resolved from store', { id: tenant.id, name: tenant.name });
  return tenant;
}
