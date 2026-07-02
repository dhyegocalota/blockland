import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import './globals.css';
import ServiceWorker from '../components/ServiceWorker';
import CookieConsent from '../components/CookieConsent';
import { getTenant } from '../lib/api';
import { tenantSubdomainOf } from '../lib/tenants';
import { ROBOTS_NOINDEX, robotsCanonicalFor } from '../lib/seo';
import { serverLocale, serverT } from '../lib/i18n/server';

const THEME_COLOR = '#22c55e';

// The landing lives only on the root, so every tenant subdomain is noindex with a canonical to the
// root; the root stays indexable, canonical to itself.
function seoMetadata(host: string): Metadata {
  const { noindex, canonical } = robotsCanonicalFor(host);
  return {
    alternates: { canonical },
    robots: noindex ? ROBOTS_NOINDEX : undefined,
  };
}

// Per-tenant title + favicon: only an actual tenant subdomain (acme.<root>) shows its own name +
// avatar. The app root (and its global pages like /admin, /welcome) stays generic "Blockland" — it
// must NOT inherit any tenant's branding. Title/description/social card are localized off the
// request locale the middleware resolved.
export async function generateMetadata(): Promise<Metadata> {
  const title = serverT('meta.title');
  const description = serverT('meta.description');
  const openGraph: Metadata['openGraph'] = {
    title: serverT('meta.og_title'),
    description,
    siteName: title,
    type: 'website',
  };
  const host = headers().get('host')?.split(':')[0];
  if (!host) return { title, description, manifest: '/manifest.webmanifest', openGraph };

  const base: Metadata = {
    title,
    description,
    manifest: '/manifest.webmanifest',
    openGraph,
    ...seoMetadata(host),
  };

  const subdomain = tenantSubdomainOf(host);
  if (!subdomain) return base;
  // The data API being down must never 500 the page: fall back to the generic metadata and let the
  // client lobby render from its cached tenant. Per-tenant title/icon are a nice-to-have, not a gate.
  const tenant = await getTenant(subdomain).catch(() => null);
  if (!tenant) return base;
  return {
    ...base,
    title: tenant.name,
    openGraph: { ...openGraph, title: tenant.name, siteName: tenant.name },
    icons: { icon: tenant.image, apple: tenant.image },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: THEME_COLOR,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={serverLocale()}>
      <body>
        <ServiceWorker />
        {children}
        <CookieConsent />
      </body>
    </html>
  );
}
