import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import ServiceWorker from './ServiceWorker';

const THEME_COLOR = '#22c55e';

export const metadata: Metadata = {
  title: 'Blockland',
  description: 'Mundos de blocos 3D pra crianças: construa, cace, lute contra monstros e junte estrelas.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/tenants/demo/avatar.png',
    apple: '/icons/icon-192.png',
  },
};

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
