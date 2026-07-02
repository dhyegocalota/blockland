import type { CSSProperties, ReactNode } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import LocaleSwitcher from '../../components/LocaleSwitcher';
import { serverLocale, serverT } from '../../lib/i18n/server';
import { GEO, landingJsonLd, rootHomeUrl } from '../../lib/seo';

const SWITCHER_WRAP: CSSProperties = {
  position: 'fixed',
  top: 14,
  right: 14,
  zIndex: 50,
};

const OG_LOCALES: Record<string, string> = { 'pt-BR': 'pt_BR', 'en-US': 'en_US' };

function landingHost(): string {
  return headers().get('host')?.split(':')[0] ?? 'localhost';
}

// Landing-only SEO: rich OpenGraph/Twitter cards (the image comes from opengraph-image.tsx), locale
// hints, keywords and legacy geo tags for local (Brazil/MG) targeting. The game route keeps the leaner
// root metadata; this deep, indexable marketing surface gets the full treatment.
export async function generateMetadata(): Promise<Metadata> {
  const title = serverT('meta.og_title');
  const description = serverT('meta.description');
  const url = rootHomeUrl(landingHost());
  return {
    description,
    keywords: serverT('meta.keywords').split(',').map((keyword) => keyword.trim()),
    openGraph: {
      type: 'website',
      siteName: serverT('meta.title'),
      title,
      description,
      url,
      locale: OG_LOCALES[serverLocale()],
    },
    twitter: { card: 'summary_large_image', title, description },
    other: {
      'geo.region': GEO.region,
      'geo.placename': GEO.placename,
      'geo.position': `${GEO.latitude};${GEO.longitude}`,
      ICBM: `${GEO.latitude}, ${GEO.longitude}`,
    },
  };
}

export default function LandingLayout({ children }: { children: ReactNode }) {
  const jsonLd = landingJsonLd({ rootUrl: rootHomeUrl(landingHost()), description: serverT('meta.description') });
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div style={SWITCHER_WRAP}>
        <LocaleSwitcher />
      </div>
      {children}
    </>
  );
}
