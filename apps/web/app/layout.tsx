import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import ServiceWorker from './ServiceWorker';
import { getTenant } from '../lib/api';
import { tenantIdFromHost } from '../lib/tenants';

const THEME_COLOR = '#22c55e';

const DESCRIPTION =
  'Mundos de blocos 3D pra crianças: construa, cace, lute contra monstros e junte estrelas.';

// Per-tenant title + favicon: resolve the tenant from the request host so each white-label
// subdomain shows its own name and avatar (PWA install + browser tab), not a generic one.
export async function generateMetadata(): Promise<Metadata> {
  const host = headers().get('host');
  const tenant = host ? await getTenant(tenantIdFromHost(host)) : null;
  if (!tenant) {
    return { title: 'Blockland', description: DESCRIPTION, manifest: '/manifest.webmanifest' };
  }
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
