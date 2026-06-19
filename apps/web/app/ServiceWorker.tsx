'use client';

import { useEffect } from 'react';
import { debug, warn } from '../lib/log';

// Registers the service worker (PWA + offline) only in production builds, so dev/HMR
// is never intercepted by a cached app shell.
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => debug('pwa', 'service worker registered', { scope: registration.scope }))
      .catch((error) => warn('pwa', 'service worker registration failed', { error: String(error) }));
  }, []);
  return null;
}
