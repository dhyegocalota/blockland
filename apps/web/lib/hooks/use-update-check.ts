'use client';

// Forces every open client onto the latest web build. The loaded build is baked in at compile time
// (NEXT_PUBLIC_APP_VERSION); /api/version reports the build that is CURRENTLY deployed. We poll it
// and, the moment the deployed version no longer matches the one we are running, flip an
// `updateRequired` flag the UI uses to show a non-dismissable "update now" screen.
import { useEffect, useState } from 'react';
import { DEFAULT_APP_VERSION } from '../engine/engine-config';
import { debug, warn } from '../log';

const POLL_MS = 60_000;
const LOADED_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? DEFAULT_APP_VERSION;

// A mismatch only forces an update when both versions are real deploys: the local 'dev' build (no
// SHA injected) must never trap a developer behind the update screen.
export function updateRequired({ loaded, deployed }: { loaded: string; deployed: string }): boolean {
  if (loaded === DEFAULT_APP_VERSION) return false;
  if (deployed === DEFAULT_APP_VERSION) return false;
  return loaded !== deployed;
}

export function useUpdateCheck(): boolean {
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    let alive = true;
    async function check(): Promise<void> {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { version: string };
        if (!alive) return;
        if (!updateRequired({ loaded: LOADED_VERSION, deployed: data.version })) return;
        debug('pwa', 'newer build deployed', { loaded: LOADED_VERSION, deployed: data.version });
        setOutdated(true);
      } catch (error) {
        warn('pwa', 'version check failed', { error: String(error) });
      }
    }
    check();
    const timer = setInterval(check, POLL_MS);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);

  return outdated;
}
