// Tenant data model + platform-level config. Tenant CONTENT (acme, demo, ...) lives in the
// database, owned by the server — nothing tenant-specific is hardcoded here.

// A tenant is a subdomain id, a display name, and one image URL that serves both the lobby avatar
// and the in-game face-block texture. It also carries the admin-controlled limits the lobby needs
// BEFORE joining: the play-time budget (minutes within a rolling window of hours; 0 = unlimited) and
// which game modes are allowed. The fields stay snake_case to match the server `db::Tenant` JSON that
// the tenant HTTP fetch deserializes verbatim. Everything else (theme color, face-block label, lobby
// copy) is derived or defaulted on the client — see `tenant-brand.ts` and the `start.tagline` key.
export interface Tenant {
  id: string;
  name: string;
  image: string;
  playtime_limit_min: number;
  playtime_window_h: number;
  online_allowed: boolean;
  offline_allowed: boolean;
}

export const PLATFORM_NAME = 'Blockland';

// The text fields the /admin tenant editor reads + writes. The limit fields (play-time + modes) are
// managed from the in-game / lobby admin panels (runtime toggles), not this form, so they stay out.
export type TenantTextField = 'id' | 'name' | 'image';

export const TENANT_FIELDS: TenantTextField[] = ['id', 'name', 'image'];
