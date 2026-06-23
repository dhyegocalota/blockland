'use client';

// The per-tenant LIMIT controls shared by the in-game (#adminPanel) and lobby (#lobbyAdmin) admin
// panels: the play-time budget (minutes + rolling window in hours; 0 = unlimited) and the allowed
// game-mode toggles (online / offline). Admin-only — the caller renders this only for an admin. The
// state + dispatch live in useRoomAdmin (room + setLimits/toggle*), this is just the markup, mirroring
// how LobbyAdmin/Game share the other admin controls.
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../lib/i18n';
import type { RoomState } from '../lib/coop';

interface AdminLimitsProps {
  room: RoomState;
  setLimits: (playtimeLimitMin: number, playtimeWindowH: number) => void;
  toggleOnlineAllowed: () => void;
  toggleOfflineAllowed: () => void;
}

// When the admin first enables a limit on a previously-unlimited world, start from a friendly default
// instead of 0 (which would still mean unlimited).
const DEFAULT_LIMIT_MIN = 30;

export default function AdminLimits({ room, setLimits, toggleOnlineAllowed, toggleOfflineAllowed }: AdminLimitsProps) {
  const [limited, setLimited] = useState(room.playtimeLimitMin > 0);
  const [limitMin, setLimitMin] = useState(String(room.playtimeLimitMin));
  const [windowH, setWindowH] = useState(String(room.playtimeWindowH));

  // Re-sync the inputs whenever the server-authoritative values change (another admin, or our own save
  // echoed back), so the fields never drift from the live RoomState.
  useEffect(() => { setLimited(room.playtimeLimitMin > 0); setLimitMin(String(room.playtimeLimitMin)); }, [room.playtimeLimitMin]);
  useEffect(() => { setWindowH(String(room.playtimeWindowH)); }, [room.playtimeWindowH]);

  function toggleLimited(next: boolean): void {
    setLimited(next);
    if (next && clampNonNegative(limitMin) === 0) setLimitMin(String(DEFAULT_LIMIT_MIN));
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!limited) { setLimits(0, clampNonNegative(windowH)); return; }
    setLimits(clampNonNegative(limitMin), clampNonNegative(windowH));
  }

  // The last enabled mode can't be turned off (a tenant always keeps one); disable that toggle.
  const lastOnline = room.onlineAllowed && !room.offlineAllowed;
  const lastOffline = room.offlineAllowed && !room.onlineAllowed;

  return (
    <div id="adminLimits">
      <span className="adminLabel">{t('game_admin.playtime')}</span>
      <form id="adminPlaytime" onSubmit={save}>
        <label className="playtimeToggle">
          <input type="checkbox" checked={limited} onChange={(e) => toggleLimited(e.target.checked)} />
          {t('game_admin.playtime_limit_toggle')}
        </label>
        {limited && (
          <label>
            {t('game_admin.playtime_minutes')}
            <input type="number" min={0} value={limitMin} onChange={(e) => setLimitMin(e.target.value)} />
          </label>
        )}
        {limited && (
          <label>
            {t('game_admin.playtime_window')}
            <input type="number" min={0} value={windowH} onChange={(e) => setWindowH(e.target.value)} />
          </label>
        )}
        <button type="submit">{t('game_admin.playtime_save')}</button>
      </form>
      <span className="adminLabel">{t('game_admin.modes')}</span>
      <button
        id="adminOnlineMode"
        className={room.onlineAllowed ? 'on' : undefined}
        disabled={lastOnline}
        onClick={toggleOnlineAllowed}
      >
        {room.onlineAllowed ? t('game_admin.online_on') : t('game_admin.online_off')}
      </button>
      <button
        id="adminOfflineMode"
        className={room.offlineAllowed ? 'on' : undefined}
        disabled={lastOffline}
        onClick={toggleOfflineAllowed}
      >
        {room.offlineAllowed ? t('game_admin.offline_on') : t('game_admin.offline_off')}
      </button>
    </div>
  );
}

function clampNonNegative(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) return 0;
  return value;
}
