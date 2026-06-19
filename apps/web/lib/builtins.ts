// Tenant data model + platform-level config. Tenant CONTENT (teo, demo, ...) lives in the
// database, owned by the server — nothing tenant-specific is hardcoded here.

export interface Tenant {
  id: string;
  name: string;
  hero: string;
  titleA: string;
  titleB: string;
  tagline: string;
  primary: string;
  avatar: string;
  faceTexture: string;
  faceBlockName: string;
}

export const PLATFORM_NAME = 'Blockland';
export const DEFAULT_TENANT = process.env.NEXT_PUBLIC_DEFAULT_TENANT || 'teo';

export const TENANT_FIELDS: (keyof Tenant)[] = [
  'id',
  'name',
  'hero',
  'titleA',
  'titleB',
  'tagline',
  'primary',
  'avatar',
  'faceTexture',
  'faceBlockName',
];
