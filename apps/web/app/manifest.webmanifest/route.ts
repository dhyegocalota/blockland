// Per-tenant PWA manifest: resolve the tenant from the request host so each white-label subdomain
// installs with its own name + avatar. Falls back to the generic Blockland branding off the app root.
import { getTenant } from '../../lib/api';
import { tenantIdFromHost } from '../../lib/tenants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Mundos de blocos 3D pra crianças: construa, cace, lute contra monstros e junte estrelas.';
const DEFAULT_ICON = '/icons/icon-192.png';

export async function GET(req: Request) {
  const host = req.headers.get('host');
  const tenant = host ? await getTenant(tenantIdFromHost(host)) : null;
  const name = tenant ? tenant.name : 'Blockland';
  const icon = tenant ? tenant.avatar : DEFAULT_ICON;
  const manifest = {
    name,
    short_name: name,
    description: DESCRIPTION,
    display: 'standalone',
    orientation: 'landscape',
    start_url: '/',
    scope: '/',
    theme_color: '#22c55e',
    background_color: '#0b1220',
    icons: [
      { src: icon, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: icon, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  return Response.json(manifest, { headers: { 'content-type': 'application/manifest+json' } });
}
