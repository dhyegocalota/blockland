'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveTenant, type Brand } from '../lib/tenants';
import { t } from '../lib/i18n';
import { debug, warn } from '../lib/log';
import { clearSession, loadSession, resolveClaim, saveSession } from '../lib/session';
import { STRUCTURE_KINDS, type CoopBridge, type DebugSnapshot } from '../lib/game-engine';
import type { Appearance, RoomState, RosterEntry } from '../lib/coop';
import { randomLook } from '../lib/look';
import { pushFeed, type FeedEntry, type FeedEvent } from '../lib/feed';
import type { NetState } from '../lib/net';
import Leaderboard from './Leaderboard';
import LobbyPresence from './LobbyPresence';

const AUTHOR_URL = 'https://dhyegocalota.com.br';

const NAME_KEY = 'bl-name';
const LOOK_KEYS = { skin: 'bl-skin', shirt: 'bl-shirt', hair: 'bl-hair' } as const;
const DEFAULT_LOOK: Appearance = { skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a' };
const CHAT_BACKLOG = 6;
const CHAT_FADE_MS = 8000;
// World reset is destructive, so the first click only arms it; the admin must confirm within this
// window or it disarms itself — a misclick can never wipe the world.
const RESET_ARM_MS = 4000;

function loadLook(): Appearance {
  if (typeof window === 'undefined') return DEFAULT_LOOK;
  return {
    skin: window.localStorage.getItem(LOOK_KEYS.skin) || DEFAULT_LOOK.skin,
    shirt: window.localStorage.getItem(LOOK_KEYS.shirt) || DEFAULT_LOOK.shirt,
    hair: window.localStorage.getItem(LOOK_KEYS.hair) || DEFAULT_LOOK.hair,
  };
}

const BANNER_KEYS: Record<NetState, string | null> = {
  connecting: 'coop.connecting',
  online: null,
  reconnecting: 'coop.reconnecting',
  offline: 'coop.offline',
  banned: 'coop.banned',
  kicked: 'coop.kicked',
  room_closed: 'coop.room_closed',
};

const SEVERE_STATES: NetState[] = ['banned', 'kicked', 'room_closed'];

const FEED_ICONS: Record<FeedEvent['kind'], string> = {
  join: '➕',
  leave: '➖',
  chat: '💬',
  rename: '✏️',
  kill: '⚔️',
  reset: '🌍',
};

function feedText(entry: FeedEntry): string {
  if (entry.kind === 'kill' && entry.detail) return t('feed.kill', { name: entry.name, detail: entry.detail });
  if (entry.kind === 'rename' && entry.detail) return t('feed.renamed', { old: entry.detail, name: entry.name });
  if (entry.kind === 'rename') return entry.name;
  if (entry.kind === 'reset') return t('feed.reset', { name: entry.name });
  return t(entry.kind === 'join' ? 'feed.joined' : 'feed.left', { name: entry.name });
}

const AUTH_ERROR_KEYS: Record<string, string> = {
  claim_required: 'auth.claim_required',
  reclaimed: 'auth.reclaimed',
};

type LoginStep = 'email' | 'code';

function loadName(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(NAME_KEY) ?? '';
}

interface ChatLine {
  id: number;
  name: string;
  text: string;
}

interface GameApi {
  sendChat(text: string): void;
  setAdminPeace(on: boolean): void;
  setAdminStructure(kind: string, allowed: boolean): void;
  setAdminPvp(on: boolean): void;
  setAdminChat(on: boolean): void;
  kickPlayer(id: number): void;
  banPlayer(id: number): void;
  resetWorld(): void;
  debugSnapshot(): DebugSnapshot;
}

const STRUCTURE_LABEL_KEYS: Record<string, string> = {
  trophy: 'build.trophy',
  ball: 'build.ball',
  figure: 'build.figure',
  cola: 'build.cola',
  steve: 'build.steve',
};

export default function Game() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [name, setName] = useState(loadName);
  const [look, setLook] = useState<Appearance>(loadLook);
  const [solo, setSolo] = useState(false);
  const [netState, setNetState] = useState<NetState | null>(null);
  const [ping, setPing] = useState(0);
  const [online, setOnline] = useState(1);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<DebugSnapshot | null>(null);
  const [loginStep, setLoginStep] = useState<LoginStep | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [authToast, setAuthToast] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [room, setRoom] = useState<RoomState>({ peace: true, blockedStructures: [], pvp: false, chatEnabled: true });
  const [adminOpen, setAdminOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);

  const gameApiRef = useRef<GameApi | null>(null);
  const resetArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soloRef = useRef(false);
  const loginClearedRef = useRef(false);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatLineId = useRef(0);
  const feedEntryId = useRef(0);

  const pushChatLine = useCallback((from: string, text: string) => {
    const id = chatLineId.current++;
    setChatLines((lines) => [...lines, { id, name: from, text }].slice(-CHAT_BACKLOG));
    setTimeout(() => setChatLines((lines) => lines.filter((line) => line.id !== id)), CHAT_FADE_MS);
  }, []);

  const pushFeedEntry = useCallback((event: FeedEvent) => {
    const id = feedEntryId.current++;
    setFeed((entries) => pushFeed({ entries, event, id, now: Date.now() }));
    setTimeout(() => setFeed((entries) => entries.filter((entry) => entry.id !== id)), CHAT_FADE_MS);
  }, []);

  // First-time players get a random look (persisted so it stays stable); done after mount to avoid a
  // hydration mismatch on the color inputs.
  useEffect(() => {
    if (window.localStorage.getItem(LOOK_KEYS.skin)) return;
    const look = randomLook();
    setLook(look);
    window.localStorage.setItem(LOOK_KEYS.skin, look.skin);
    window.localStorage.setItem(LOOK_KEYS.shirt, look.shirt);
    window.localStorage.setItem(LOOK_KEYS.hair, look.hair);
  }, []);

  useEffect(() => {
    let alive = true;
    resolveTenant()
      .then(({ tenant: active, offline: isOffline }) => {
        if (!alive) return;
        debug('tenant', 'active tenant', { id: active.id, name: active.name, offline: isOffline });
        setBrand(active);
        setOffline(isOffline);
      })
      .catch((err) => {
        if (!alive) return;
        warn('tenant', 'failed to load tenant', { error: String(err) });
        setFailed(true);
      });
    return () => { alive = false; };
  }, []);

  // Boot the engine only after `brand` has rendered, so the HUD DOM (#controls, #start, ...) the engine
  // wires up actually exists. Running this inside the tenant promise raced React's commit and threw.
  useEffect(() => {
    if (!brand) return;
    let cleanup: (() => void) | undefined;
    let alive = true;
    const bridge: CoopBridge = {
      resolveName: () => loadName().trim(),
      resolveAppearance: () => loadLook(),
      resolveClaim: (resolvedName) => resolveClaim(brand.id, resolvedName),
      resolveOffline: () => soloRef.current,
      hud: {
        onState: (state) => setNetState(state),
        onPing: (value) => setPing(value),
        onChat: (from, text) => pushChatLine(from, text),
        onCount: (count) => setOnline(count),
        onRoster: (players) => setRoster(players),
        onEvent: (event) => pushFeedEntry(event),
        // Score is authoritative from the snapshot; the engine paints the topbar star/record DOM.
        onScore: () => undefined,
        onAdmin: (admin) => setIsAdmin(admin),
        onRoomState: (state) => setRoom(state),
        onError: (code) => {
          const key = AUTH_ERROR_KEYS[code];
          if (key) setAuthToast(t(key));
        },
      },
      bind: (api) => { gameApiRef.current = api; },
    };
    import('../lib/game-engine').then((mod) => {
      if (!alive) return;
      debug('engine', 'engine module loaded', { id: brand.id, name: brand.name });
      cleanup = mod.initGame(brand, bridge);
    });
    return () => { alive = false; if (cleanup) cleanup(); };
  }, [brand, pushChatLine, pushFeedEntry]);

  const openChat = useCallback(() => {
    if (!room.chatEnabled) return;
    setChatOpen(true);
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [room.chatEnabled]);

  const sendChat = useCallback(() => {
    const text = chatDraft.trim();
    if (text) gameApiRef.current?.sendChat(text);
    setChatDraft('');
    setChatOpen(false);
  }, [chatDraft]);

  const toggleRoomPeace = useCallback(() => {
    gameApiRef.current?.setAdminPeace(!room.peace);
  }, [room.peace]);

  const toggleStructure = useCallback((kind: string, allowed: boolean) => {
    gameApiRef.current?.setAdminStructure(kind, allowed);
  }, []);

  const toggleRoomPvp = useCallback(() => {
    gameApiRef.current?.setAdminPvp(!room.pvp);
  }, [room.pvp]);

  const toggleRoomChat = useCallback(() => {
    gameApiRef.current?.setAdminChat(!room.chatEnabled);
  }, [room.chatEnabled]);

  const kickPlayer = useCallback((id: number) => {
    gameApiRef.current?.kickPlayer(id);
  }, []);

  const banPlayer = useCallback((id: number) => {
    gameApiRef.current?.banPlayer(id);
  }, []);

  const resetWorld = useCallback(() => {
    if (!resetArmed) {
      setResetArmed(true);
      if (resetArmTimer.current) clearTimeout(resetArmTimer.current);
      resetArmTimer.current = setTimeout(() => setResetArmed(false), RESET_ARM_MS);
      return;
    }
    if (resetArmTimer.current) clearTimeout(resetArmTimer.current);
    setResetArmed(false);
    gameApiRef.current?.resetWorld();
  }, [resetArmed]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.code === 'F3') { event.preventDefault(); setDebugOpen((open) => !open); return; }
      if (chatOpen) return;
      const typingTarget = event.target instanceof HTMLInputElement;
      if (typingTarget) return;
      if (event.code === 'Enter' || event.code === 'KeyT') { event.preventDefault(); openChat(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatOpen, openChat]);

  // When an admin disables the room chat, close any open input and drop the draft.
  useEffect(() => {
    if (room.chatEnabled) return;
    setChatOpen(false);
    setChatDraft('');
  }, [room.chatEnabled]);

  useEffect(() => {
    if (!debugOpen) return;
    let rafId = 0;
    const tick = (): void => {
      const api = gameApiRef.current;
      if (api) setDebugData(api.debugSnapshot());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [debugOpen]);

  function onNameChange(value: string): void {
    setName(value);
    if (typeof window !== 'undefined') window.localStorage.setItem(NAME_KEY, value);
  }

  function onLookChange(part: keyof Appearance, value: string): void {
    setLook((current) => ({ ...current, [part]: value }));
    if (typeof window !== 'undefined') window.localStorage.setItem(LOOK_KEYS[part], value);
  }

  const needsLogin = useCallback((): boolean => {
    if (soloRef.current) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (!brand) return false;
    return resolveClaim(brand.id, trimmed) === '';
  }, [brand, name]);

  // Gate the engine's Play button: a named player with no valid session must log in first. We block
  // the engine's own click listener in the capture phase and open the login step instead. Once the
  // claim is stored we re-fire Play with the gate cleared so the engine boots normally.
  useEffect(() => {
    if (!brand) return;
    const playBtn = document.getElementById('playBtn');
    if (!playBtn) return;
    function gate(event: MouseEvent): void {
      if (loginClearedRef.current) return;
      if (!needsLogin()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLoginError(null);
      setLoginCode('');
      setLoginStep('email');
    }
    playBtn.addEventListener('click', gate, { capture: true });
    return () => playBtn.removeEventListener('click', gate, { capture: true });
  }, [brand, needsLogin]);

  useEffect(() => {
    if (!brand) return;
    const session = loadSession();
    setLoggedIn(!!session && session.tenant === brand.id);
  }, [brand, loginStep]);

  useEffect(() => {
    if (!authToast) return;
    const timer = setTimeout(() => setAuthToast(null), CHAT_FADE_MS);
    return () => clearTimeout(timer);
  }, [authToast]);

  const finishLogin = useCallback(() => {
    loginClearedRef.current = true;
    setLoginStep(null);
    setLoggedIn(true);
    document.getElementById('playBtn')?.click();
  }, []);

  // Drop the unconfirmed name so the player becomes an anonymous guest. Used by ESC (just back out)
  // and by the "play with a random name" button (which then starts the game).
  const discardName = useCallback(() => {
    setName('');
    if (typeof window !== 'undefined') window.localStorage.setItem(NAME_KEY, '');
    setLoginError(null);
    setLoginStep(null);
  }, []);

  const playAsGuest = useCallback(() => {
    discardName();
    loginClearedRef.current = true;
    document.getElementById('playBtn')?.click();
  }, [discardName]);

  // ESC out of the name-confirm modal also discards the unconfirmed name (back to playing as a guest).
  useEffect(() => {
    if (!loginStep) return;
    function onKey(event: KeyboardEvent): void {
      if (event.code === 'Escape') { event.preventDefault(); discardName(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loginStep, discardName]);

  // Clicking outside an open in-game overlay closes it.
  useEffect(() => {
    if (!adminOpen && !rosterOpen) return;
    function onDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (adminOpen && !document.getElementById('adminPanel')?.contains(target)) setAdminOpen(false);
      if (rosterOpen && !document.getElementById('presence')?.contains(target)) setRosterOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [adminOpen, rosterOpen]);

  const requestCode = useCallback(async () => {
    if (!brand) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant: brand.id, name: name.trim(), email: loginEmail.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setLoginError(t(data.error === 'not_owner' ? 'login.error_not_owner' : 'login.error_invalid'));
        return;
      }
      setLoginStep('code');
    } catch {
      setLoginError(t('login.error_generic'));
    } finally {
      setLoginBusy(false);
    }
  }, [brand, name, loginEmail]);

  const verifyCode = useCallback(async () => {
    if (!brand) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant: brand.id, name: name.trim(), code: loginCode.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; tenant?: string; name?: string; claim?: string };
      if (!data.ok || !data.tenant || !data.name || !data.claim) {
        setLoginError(t('login.error_code'));
        return;
      }
      saveSession({ tenant: data.tenant, name: data.name, claim: data.claim });
      finishLogin();
    } catch {
      setLoginError(t('login.error_generic'));
    } finally {
      setLoginBusy(false);
    }
  }, [brand, name, loginCode, finishLogin]);

  const logout = useCallback(async () => {
    const session = loadSession();
    if (session) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(session),
      }).catch(() => undefined);
    }
    clearSession();
    loginClearedRef.current = false;
    setLoggedIn(false);
  }, []);

  // A logged-in player can rename without re-emailing. On success we update the stored session +
  // name field so the next Join carries the new name (resolveClaim keys on it), and show a toast.
  if (failed) return <div id="loadError">{t('error.connect')}</div>;
  if (!brand) return null;

  const bannerKey = netState ? BANNER_KEYS[netState] : null;
  const severe = netState ? SEVERE_STATES.includes(netState) : false;
  const showPing = netState === 'online';

  return (
    <>
      <div id="hud">
        <div id="topbar">
          <img src={brand.avatar} alt={brand.hero} />
          <span className="title">{brand.name}</span>
          <span className="stat" id="hearts">❤️❤️❤️</span>
          <span className="stat" id="stars">⭐ 0</span>
          <span className="stat record" id="record">🏆 0</span>
          <span className="stat" id="bag">🎒 0</span>
          {showPing && <span className="stat" id="ping">{t('coop.ping', { ping })}</span>}
        </div>
        <div id="crosshair"></div>
        <div id="toast"></div>
        <div id="hotbar"></div>
        <div id="actionRow">
          <button className="btn" id="helpBtn">{t('hud.controls')}</button>
          <button className="btn" id="buildBtn">{t('hud.build')}</button>
          <button className="btn" id="flyBtn">{t('hud.fly')}</button>
          {room.chatEnabled && <button className="btn" id="chatBtn" onClick={openChat}>{t('hud.chat')}</button>}
          <button className="btn" id="exitBtn" onClick={() => window.location.reload()}>{t('hud.exit')}</button>
        </div>
      </div>

      <div id="presence" className={rosterOpen ? 'open' : undefined}>
        <button id="presenceToggle" onClick={() => setRosterOpen((open) => !open)} aria-expanded={rosterOpen}>
          👥 {online}
        </button>
        {rosterOpen && (
          <ul id="presenceList">
            {roster.map((player) => (
              <li key={player.id} className={player.self ? 'self' : undefined}>
                {player.self ? t('presence.you', { name: player.name }) : player.name}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && (
        <div id="adminPanel" className={adminOpen ? 'open' : undefined}>
          <button id="adminToggle" onClick={() => setAdminOpen((open) => !open)} aria-expanded={adminOpen}>
            🛡️ {t('game_admin.title')}
          </button>
          {adminOpen && (
            <div id="adminBody">
              <button
                id="adminPeace"
                className={room.peace ? undefined : 'on'}
                onClick={toggleRoomPeace}
              >
                {room.peace ? t('game_admin.monsters_calm') : t('game_admin.monsters_attack')}
              </button>
              <button
                id="adminPvp"
                className={room.pvp ? 'on' : undefined}
                onClick={toggleRoomPvp}
              >
                {room.pvp ? t('game_admin.pvp_on') : t('game_admin.pvp_off')}
              </button>
              <button
                id="adminChat"
                className={room.chatEnabled ? undefined : 'on'}
                onClick={toggleRoomChat}
              >
                {room.chatEnabled ? t('game_admin.chat_on') : t('game_admin.chat_off')}
              </button>
              <span className="adminLabel">{t('game_admin.players')}</span>
              <ul id="adminPlayers">
                {roster.filter((player) => !player.self).map((player) => (
                  <li key={player.id}>
                    <span>{player.name}</span>
                    <span className="adminPlayerActions">
                      <button className="kick" onClick={() => kickPlayer(player.id)}>{t('game_admin.kick')}</button>
                      <button className="ban" onClick={() => banPlayer(player.id)}>{t('game_admin.ban')}</button>
                    </span>
                  </li>
                ))}
              </ul>
              <span className="adminLabel">{t('game_admin.structures')}</span>
              <ul id="adminStructures">
                {STRUCTURE_KINDS.map((kind) => {
                  const blocked = room.blockedStructures.includes(kind);
                  return (
                    <li key={kind}>
                      <span>{t(STRUCTURE_LABEL_KEYS[kind])}</span>
                      <button
                        className={blocked ? 'blocked' : 'allowed'}
                        onClick={() => toggleStructure(kind, blocked)}
                      >
                        {blocked ? t('game_admin.blocked') : t('game_admin.allowed')}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button id="adminReset" className={resetArmed ? 'armed' : undefined} onClick={resetWorld}>
                {resetArmed ? t('game_admin.reset_confirm') : t('game_admin.reset')}
              </button>
            </div>
          )}
        </div>
      )}

      {bannerKey && (
        <div id="netBanner" className={severe ? 'severe' : undefined} role="status">{t(bannerKey)}</div>
      )}

      {authToast && (
        <div id="authToast" className="severe" role="status">{authToast}</div>
      )}

      {loginStep && (
        <div
          id="loginModal"
          role="dialog"
          aria-modal="true"
          onClick={(event) => { if (event.target === event.currentTarget) discardName(); }}
        >
          <div className="panel">
            {loginStep === 'email' && (
              <>
                <h2>{t('login.email_title')}</h2>
                <p>{t('login.email_hint', { name: name.trim() })}</p>
                <input
                  id="loginEmail"
                  type="email"
                  value={loginEmail}
                  placeholder={t('login.email_placeholder')}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.code === 'Enter') { e.preventDefault(); requestCode(); } }}
                />
                {loginError && <p className="loginError">{loginError}</p>}
                <button id="loginSend" disabled={loginBusy || !loginEmail.trim()} onClick={requestCode}>
                  {loginBusy ? t('login.sending') : t('login.send_code')}
                </button>
                <button id="loginCancel" className="ghost" onClick={playAsGuest}>{t('login.random_name')}</button>
              </>
            )}
            {loginStep === 'code' && (
              <>
                <h2>{t('login.code_title')}</h2>
                <p>{t('login.code_hint', { email: loginEmail.trim() })}</p>
                <input
                  id="loginCode"
                  inputMode="numeric"
                  maxLength={6}
                  value={loginCode}
                  placeholder={t('login.code_placeholder')}
                  onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.code === 'Enter') { e.preventDefault(); verifyCode(); } }}
                />
                {loginError && <p className="loginError">{loginError}</p>}
                <button id="loginVerify" disabled={loginBusy || loginCode.trim().length < 6} onClick={verifyCode}>
                  {loginBusy ? t('login.verifying') : t('login.verify')}
                </button>
                <button id="loginCancel" className="ghost" onClick={playAsGuest}>{t('login.random_name')}</button>
              </>
            )}
          </div>
        </div>
      )}

      {offline && !offlineDismissed && (
        <div id="offlineNotice" role="dialog" aria-modal="true">
          <div className="panel">
            <h2>{t('offline.title')}</h2>
            <p>{t('offline.body')}</p>
            <button id="offlinePlay" onClick={() => setOfflineDismissed(true)}>{t('offline.play')}</button>
          </div>
        </div>
      )}

      <div id="feed">
        {feed.map((entry) => (
          <div className={entry.kind === 'rename' || entry.kind === 'kill' ? 'feedLine system' : 'feedLine'} key={entry.id}>
            <span className="feedIcon">{FEED_ICONS[entry.kind]}</span>
            {feedText(entry)}
          </div>
        ))}
      </div>

      <div id="chat" hidden={!room.chatEnabled}>
        <div id="chatLog">
          {chatLines.map((line) => (
            <div className="chatLine" key={line.id}>{t('chat.line', { name: line.name, text: line.text })}</div>
          ))}
        </div>
        {chatOpen && (
          <input
            id="chatInput"
            ref={chatInputRef}
            value={chatDraft}
            placeholder={t('chat.placeholder')}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === 'Enter') { e.preventDefault(); sendChat(); }
              if (e.code === 'Escape') { e.preventDefault(); setChatDraft(''); setChatOpen(false); }
            }}
          />
        )}
      </div>

      <button
        id="debugToggle"
        className={debugOpen ? 'on' : undefined}
        onClick={() => setDebugOpen((open) => !open)}
        title={t('debug.title')}
        aria-label="Debug"
      >
        🐞
      </button>

      {debugOpen && debugData && (
        <div id="debugPanel">
          <h3>{t('debug.title')}</h3>
          <div><span>{t('debug.fps')}</span><b>{debugData.fps}</b></div>
          <div><span>{t('debug.ping')}</span><b>{debugData.ping}ms</b></div>
          <div><span>{t('debug.state')}</span><b>{debugData.state}</b></div>
          <div><span>{t('debug.online')}</span><b>{debugData.online}</b></div>
          <div><span>{t('debug.pos')}</span><b>{debugData.x}, {debugData.y}, {debugData.z}</b></div>
          <div><span>{t('debug.chunks')}</span><b>{debugData.chunks}</b></div>
          <div><span>{t('debug.tenant')}</span><b>{debugData.tenant}</b></div>
        </div>
      )}

      <div id="touchControls" style={{ display: 'none' }}>
        <div id="joystick"><div id="joyKnob"></div></div>
        <div id="touchButtons">
          <button id="btnUp" className="tbtn">⤴️</button>
          <button id="btnDown" className="tbtn">⤵️</button>
          <button id="btnPlace" className="tbtn place">🧱</button>
          <button id="btnBreak" className="tbtn break">⛏️</button>
        </div>
      </div>

      <div id="controls" hidden>
        <div className="panel">
          <h2>{t('controls.title')}</h2>
          <div className="ctrlGrid">
            <div className="card"><b>{t('controls.move')}</b> {t('controls.move_keys')}</div>
            <div className="card"><b>{t('controls.jump')}</b> {t('controls.jump_keys')}</div>
            <div className="card"><b>{t('controls.fly_land')}</b> {t('controls.fly_land_keys')}</div>
            <div className="card"><b>{t('controls.look')}</b> {t('controls.look_keys')}</div>
            <div className="card"><b>{t('controls.break')}</b> {t('controls.break_keys')}</div>
            <div className="card"><b>{t('controls.build')}</b> {t('controls.build_keys')}</div>
            <div className="card"><b>{t('controls.pick_block')}</b> {t('controls.pick_block_keys')}</div>
            <div className="card"><b>{t('controls.hunt')}</b> {t('controls.hunt_keys')}</div>
            <div className="card"><b>{t('controls.fight')}</b> {t('controls.fight_keys')}</div>
            <div className="card"><b>{t('controls.collect')}</b> {t('controls.collect_keys')}</div>
            <div className="card"><b>{t('controls.your_face')}</b> {t('controls.your_face_keys')}</div>
            <div className="card"><b>{t('controls.peace_mode')}</b> {t('controls.peace_mode_keys')}</div>
            <div className="card"><b>{t('controls.structures')}</b> {t('controls.structures_keys')}</div>
            <div className="card"><b>{t('controls.show_controls')}</b> {t('controls.show_controls_keys')}</div>
          </div>
          <button id="closeControls">{t('controls.close')}</button>
        </div>
      </div>

      <div id="buildMenu" hidden>
        <div className="panel">
          <h2>{t('build.menu_title')}</h2>
          <p className="buildHint">{t('build.menu_hint')}</p>
          <div className="buildGrid">
            <button className="buildCard" data-kind="trophy"><span className="emoji">🏆</span><span>{t('build.trophy')}</span></button>
            <button className="buildCard" data-kind="ball"><span className="emoji">⚽</span><span>{t('build.ball')}</span></button>
            <button className="buildCard" data-kind="figure"><span className="emoji">🧑‍🦱</span><span>{t('build.figure')}</span></button>
            <button className="buildCard" data-kind="cola"><span className="emoji">🥤</span><span>{t('build.cola')}</span></button>
            <button className="buildCard" data-kind="steve"><span className="emoji">🧍</span><span>{t('build.steve')}</span></button>
          </div>
          <button id="closeBuild">{t('build.close')}</button>
        </div>
      </div>

      <div id="start">
        <img className="avatar" src={brand.avatar} alt={brand.hero} />
        <h1>{brand.titleA}<span className="accent">{brand.titleB}</span></h1>
        <p dangerouslySetInnerHTML={{ __html: brand.tagline }} />
        <span className="record-badge" id="startRecord">{t('start.record')}</span>
        <LobbyPresence tenant={brand.id} />
        <label id="nameField">
          {t('start.name_label')}
          <input
            id="nameInput"
            value={name}
            maxLength={16}
            placeholder={t('start.name_placeholder')}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </label>
        {loggedIn && (
          <div id="sessionActions">
            <button id="logoutBtn" className="ghost" onClick={logout}>{t('login.logout')}</button>
          </div>
        )}
        <div id="lookField">
          <span className="lookTitle">{t('customize.title')}</span>
          <label>{t('customize.skin')}<input type="color" value={look.skin} onChange={(e) => onLookChange('skin', e.target.value)} /></label>
          <label>{t('customize.shirt')}<input type="color" value={look.shirt} onChange={(e) => onLookChange('shirt', e.target.value)} /></label>
          <label>{t('customize.hair')}<input type="color" value={look.hair} onChange={(e) => onLookChange('hair', e.target.value)} /></label>
        </div>
        <button
          id="startHelpBtn"
          className="ghost"
          onClick={() => { const c = document.getElementById('controls'); if (c) c.hidden = false; }}
        >
          {t('start.instructions')}
        </button>
        <div id="modeToggle">
          <button className={solo ? '' : 'on'} onClick={() => { soloRef.current = false; setSolo(false); }}>
            {t('start.mode_multi')}
          </button>
          <button className={solo ? 'on' : ''} onClick={() => { soloRef.current = true; setSolo(true); }}>
            {t('start.mode_solo')}
          </button>
        </div>
        <button id="playBtn">{t('start.play')}</button>
        <Leaderboard tenant={brand.id} />
        <footer id="startFooter">
          <a className="wantGame" href="/welcome">{t('lobby.want_game')}</a>
          <a className="credit" href={AUTHOR_URL} target="_blank" rel="noopener noreferrer">{t('lobby.credit')}</a>
        </footer>
      </div>
    </>
  );
}
