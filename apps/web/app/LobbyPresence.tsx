'use client';

// Lobby presence: how many players (and who) are online in this tenant, shown on the start screen
// before joining. Polls the public /api/online/:tenant endpoint and quietly hides when nobody is on.
import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';
import type { OnlinePresence } from '../lib/api';

const POLL_MS = 15000;
const NAMES_SHOWN = 8;

export default function LobbyPresence({ tenant }: { tenant: string }) {
  const [presence, setPresence] = useState<OnlinePresence | null>(null);

  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      try {
        const res = await fetch(`/api/online/${encodeURIComponent(tenant)}`);
        if (!res.ok) return;
        const data = (await res.json()) as OnlinePresence;
        if (alive) setPresence(data);
      } catch {
        // keep the last value; the lobby never blocks on this
      }
    }
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [tenant]);

  if (!presence) return null;
  if (presence.count === 0 && !presence.suspended) return null;
  return (
    <div id="lobbyPresence">
      {presence.suspended && <span className="suspended">{t('lobby.suspended')}</span>}
      {presence.count > 0 && (
        <span className="count">{t('lobby.online', { count: String(presence.count) })}</span>
      )}
      {presence.names.length > 0 && (
        <span className="names">{presence.names.slice(0, NAMES_SHOWN).join(' · ')}</span>
      )}
    </div>
  );
}
