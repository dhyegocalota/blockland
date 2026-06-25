// Last-known tenant branding cached in localStorage so the lobby paints INSTANTLY on a return visit and
// keeps working when the data API is down. Pure storage + a pure connectivity decision, both unit-tested.
import type { Tenant } from './builtins';

const CACHE_PREFIX = 'bl-tenant:';

export function loadCachedTenant(id: string | null): Tenant | null {
  if (!id) return null;
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const raw = window.localStorage.getItem(CACHE_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Tenant;
  } catch {
    return null;
  }
}

export function saveCachedTenant(tenant: Tenant): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(CACHE_PREFIX + tenant.id, JSON.stringify(tenant));
}

// Why the lobby is in a degraded state after the live tenant fetch failed: the browser reports no
// network (`no_internet`) versus the network is up but the game server didn't answer (`server_down`).
// `online` means the fetch succeeded. Drives the lobby banner so the player knows which it is.
export type Connectivity = 'online' | 'server_down' | 'no_internet';

export function connectivityAfterFetch({
  fetched,
  navigatorOnline,
}: {
  fetched: boolean;
  navigatorOnline: boolean;
}): Connectivity {
  if (fetched) return 'online';
  if (!navigatorOnline) return 'no_internet';
  return 'server_down';
}
