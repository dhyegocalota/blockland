// Client-side tenant resolution. Picks the tenant id from `?tenant=` or the subdomain,
// fetches its branding from the store, and falls back to the built-ins if offline.
import { BUILTIN_TENANTS, DEFAULT_TENANT } from './builtins';

export { PLATFORM_NAME } from './builtins';

export function tenantIdFromLocation() {
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

export async function resolveTenant() {
  const id = tenantIdFromLocation();
  try {
    const res = await fetch(`/api/tenants/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch {
    /* offline -> fall through to built-ins */
  }
  if (BUILTIN_TENANTS[id]) return BUILTIN_TENANTS[id];
  return BUILTIN_TENANTS[DEFAULT_TENANT];
}
