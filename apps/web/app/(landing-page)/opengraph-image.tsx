// Branded 1200x630 social card for the parent-facing landing (og:image + twitter image), auto-wired by
// Next's file convention for every landing route. Echoes the lobby look: blue sky, a chunky block and
// the Blockland wordmark. Static pt-BR (the default display locale); social cards stay one language.
import { ImageResponse } from 'next/og';
import { PLATFORM_NAME } from '../../lib/builtins';

export const alt = 'Blockland — mundos de blocos 3D privados e seguros pra crianças';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function LandingOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 20,
          background: 'radial-gradient(circle at 50% 18%, #bfeaff, #7ec8ff 55%, #4aa3e0)',
          color: '#2a1a4a', fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 150 }}>🧱</div>
        <div style={{ fontSize: 120, fontWeight: 900, color: '#ff5d2e' }}>{PLATFORM_NAME}</div>
        <div style={{ fontSize: 44, fontWeight: 800, maxWidth: 900, textAlign: 'center' }}>
          Mundos de blocos 3D privados e seguros pra crianças
        </div>
      </div>
    ),
    { ...size, emoji: 'twemoji' },
  );
}
