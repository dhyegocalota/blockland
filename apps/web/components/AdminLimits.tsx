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

// Enabling a limit starts from a friendly default (never 0, which would mean unlimited): 5 minutes
// every 24 hours. Both fields are always at least 1 while limited.
const DEFAULT_LIMIT_MIN = 5;
const DEFAULT_WINDOW_H = 24;

export default function AdminLimits({ room, setLimits, toggleOnlineAllowed, toggleOfflineAllowed }: AdminLimitsProps) {
  const [limited, setLimited] = useState(room.playtimeLimitMin > 0);
  const [limitMin, setLimitMin] = useState(String(room.playtimeLimitMin || DEFAULT_LIMIT_MIN));
  const [windowH, setWindowH] = useState(String(room.playtimeWindowH || DEFAULT_WINDOW_H));

  // Re-sync the inputs when the server-authoritative values change (another admin, or our own save
  // echoed back). Keep the friendly defaults visible while unlimited so enabling never shows 0.
  useEffect(() => {
    setLimited(room.playtimeLimitMin > 0);
    if (room.playtimeLimitMin > 0) setLimitMin(String(room.playtimeLimitMin));
  }, [room.playtimeLimitMin]);
  useEffect(() => { if (room.playtimeWindowH > 0) setWindowH(String(room.playtimeWindowH)); }, [room.playtimeWindowH]);

  // Switching the checkbox saves immediately: on → the (non-zero) minutes/window, off → unlimited (0).
  function toggleLimited(next: boolean): void {
    setLimited(next);
    if (!next) { setLimits(0, clampPositive(windowH, DEFAULT_WINDOW_H)); return; }
    const min = clampPositive(limitMin, DEFAULT_LIMIT_MIN);
    const window = clampPositive(windowH, DEFAULT_WINDOW_H);
    setLimitMin(String(min));
    setWindowH(String(window));
    setLimits(min, window);
  }

  // Editing a field saves automatically (on blur / submit), clamping a blank or zero back to the default
  // so a limited world is never accidentally set to 0 = unlimited.
  function commitFields(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    if (!limited) return;
    const min = clampPositive(limitMin, DEFAULT_LIMIT_MIN);
    const window = clampPositive(windowH, DEFAULT_WINDOW_H);
    setLimitMin(String(min));
    setWindowH(String(window));
    setLimits(min, window);
  }

  // The last enabled mode can't be turned off (a tenant always keeps one); disable that toggle.
  const lastOnline = room.onlineAllowed && !room.offlineAllowed;
  const lastOffline = room.offlineAllowed && !room.onlineAllowed;

  return (
    <div id="adminLimits">
      <span className="adminLabel">{t('game_admin.playtime')}</span>
      <form id="adminPlaytime" onSubmit={commitFields}>
        <label className="playtimeToggle">
          <input type="checkbox" checked={limited} onChange={(e) => toggleLimited(e.target.checked)} />
          {t('game_admin.playtime_limit_toggle')}
        </label>
        {limited && (
          <label>
            {t('game_admin.playtime_minutes')}
            <input type="number" min={1} value={limitMin} onChange={(e) => setLimitMin(e.target.value)} onBlur={() => commitFields()} />
          </label>
        )}
        {limited && (
          <label>
            {t('game_admin.playtime_window')}
            <input type="number" min={1} value={windowH} onChange={(e) => setWindowH(e.target.value)} onBlur={() => commitFields()} />
          </label>
        )}
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

function clampPositive(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 1) return fallback;
  return value;
}
