'use client';

import { useEffect, type ReactNode } from 'react';

export default function GameLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('game');
    document.body.classList.add('game');
    return () => {
      root.classList.remove('game');
      document.body.classList.remove('game');
    };
  }, []);
  return <>{children}</>;
}
