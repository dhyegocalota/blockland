// Tenant data model + platform-level config. Tenant CONTENT (teo, demo, ...) lives in the
// database, owned by the server — nothing tenant-specific is hardcoded here.

// A tenant is a subdomain id, a display name, and one image URL that serves both the lobby avatar
// and the in-game face-block texture. Everything else (theme color, face-block label, lobby copy)
// is derived or defaulted on the client — see `tenant-brand.ts` and the `start.tagline` i18n key.
export interface Tenant {
  id: string;
  name: string;
  image: string;
}

export const PLATFORM_NAME = 'Blockland';
export const DEFAULT_TENANT = process.env.NEXT_PUBLIC_DEFAULT_TENANT || 'teo';

export const TENANT_FIELDS: (keyof Tenant)[] = ['id', 'name', 'image'];
