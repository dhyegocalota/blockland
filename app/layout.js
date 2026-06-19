import './globals.css';

export const metadata = {
  title: 'Blocklandia',
  description: 'Mundos de blocos 3D pra crianças: construa, cace, lute contra monstros e junte estrelas.',
  icons: { icon: '/teo-avatar.png' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
