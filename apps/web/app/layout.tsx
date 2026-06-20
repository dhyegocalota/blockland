import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import ServiceWorker from './ServiceWorker';
import { getTenant } from '../lib/api';
import { tenantSubdomainOf } from '../lib/tenants';

const THEME_COLOR = '#22c55e';

const DESCRIPTION =
  'Mundos de blocos 3D pra crianças: construa, cace, lute contra monstros e junte estrelas.';
const BLOCKLAND_METADATA: Metadata = {
  title: 'Blockland',
  description: DESCRIPTION,
  manifest: '/manifest.webmanifest',
};

// Per-tenant title + favicon: only an actual tenant subdomain (teo.<root>) shows its own name +
// avatar. The app root (and its global pages like /admin, /welcome) stays generic "Blockland" — it
// must NOT inherit the default tenant's branding.
export async function generateMetadata(): Promise<Metadata> {
  const host = headers().get('host');
  const subdomain = host ? tenantSubdomainOf(host) : null;
  if (!subdomain) return BLOCKLAND_METADATA;
  const tenant = await getTenant(subdomain);
  if (!tenant) return BLOCKLAND_METADATA;
  return {
    title: tenant.name,
    description: DESCRIPTION,
    manifest: '/manifest.webmanifest',
    icons: { icon: tenant.avatar, apple: tenant.avatar },
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
    <html lang="pt-BR">
      <body>
        <ServiceWorker />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
