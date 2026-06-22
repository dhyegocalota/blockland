// Per-tenant PWA manifest: resolve the tenant from the request host so each white-label subdomain
// installs with its own name + avatar. Falls back to the generic Blockland branding off the app root.
// The description is localized off the request (bl-locale cookie, then Accept-Language); the manifest
// route is excluded from the locale-prefix middleware, so it reads the request directly.
import { getTenant } from '../../lib/api';
import { tenantSubdomainOf } from '../../lib/tenants';
import { translate } from '../../lib/i18n';
import { LOCALE_COOKIE, isLocale, localeFromAcceptLanguage } from '../../lib/i18n/locale';
import { type Locale } from '../../lib/i18n/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_ICON = '/icons/icon-192.png';

function manifestLocale(req: Request): Locale {
  const cookie = req.headers.get('cookie');
  const match = cookie?.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  if (match && isLocale(match[1])) return match[1];
  return localeFromAcceptLanguage(req.headers.get('accept-language'));
}

export async function GET(req: Request) {
  const host = req.headers.get('host');
  const subdomain = host ? tenantSubdomainOf(host) : null;
  const tenant = subdomain ? await getTenant(subdomain) : null;
  const name = tenant ? tenant.name : translate(manifestLocale(req), 'meta.title');
  const icon = tenant ? tenant.image : DEFAULT_ICON;
  const manifest = {
    name,
    short_name: name,
    description: translate(manifestLocale(req), 'meta.description'),
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
