'use client';

// All of the Game screen's state, effects and handlers live here so the component is just markup.
// It owns the lobby/login lifecycle, boots the Three.js engine via a CoopBridge, and composes the
// smaller hooks (chat, feed, room-admin). The returned object is spread into the component.
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveTenant, type Brand } from '../lib/tenants';
import { t } from '../lib/i18n';
import { debug, warn } from '../lib/log';
import { clearSession, loadSession, resolveClaim, saveSession } from '../lib/session';
import { type CoopBridge, type DebugSnapshot, type GameApi } from '../lib/game-engine';
import type { Appearance, RosterEntry } from '../lib/coop';
import { randomLook } from '../lib/look';
import { CHAT_FADE_MS } from '../lib/chat';
import { useChat } from '../lib/hooks/use-chat';
import { useFeed } from '../lib/hooks/use-feed';
import { useRoomAdmin } from '../lib/hooks/use-room-admin';
import type { NetState } from '../lib/net';

const NAME_KEY = 'bl-name';
const LOOK_KEYS = { skin: 'bl-skin', shirt: 'bl-shirt', hair: 'bl-hair' } as const;
const DEFAULT_LOOK: Appearance = { skin: '#f2c18b', shirt: '#ff5d2e', hair: '#3a2a1a' };

const AUTH_ERROR_KEYS: Record<string, string> = {
  claim_required: 'auth.claim_required',
  reclaimed: 'auth.reclaimed',
};

export type LoginStep = 'email' | 'code';

function loadLook(): Appearance {
  if (typeof window === 'undefined') return DEFAULT_LOOK;
  return {
    skin: window.localStorage.getItem(LOOK_KEYS.skin) || DEFAULT_LOOK.skin,
    shirt: window.localStorage.getItem(LOOK_KEYS.shirt) || DEFAULT_LOOK.shirt,
    hair: window.localStorage.getItem(LOOK_KEYS.hair) || DEFAULT_LOOK.hair,
  };
}

function loadName(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(NAME_KEY) ?? '';
}

export function useGame() {
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
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<DebugSnapshot | null>(null);
  const [loginStep, setLoginStep] = useState<LoginStep | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [authToast, setAuthToast] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [lobbyAdmin, setLobbyAdmin] = useState(false);
  const [lobbyModerator, setLobbyModerator] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [infiniteResources, setInfiniteResources] = useState(true);

  const gameApiRef = useRef<GameApi | null>(null);
  const soloRef = useRef(false);
  const loginClearedRef = useRef(false);

  const { entries: feed, pushFeedEntry } = useFeed();
  const {
    room, setRoom, isAdmin, setIsAdmin, isModerator, setIsModerator, adminOpen, setAdminOpen,
    resetArmed, resetWorld, toggleRoomPeace, toggleStructure, toggleRoomPvp, toggleRoomChat,
    kickPlayer, banPlayer, setRole,
    pendingApprovals, setPendingApprovals, toggleApprovalRequired, approvePlayer,
  } = useRoomAdmin(gameApiRef);
  const {
    lines: chatLines, open: chatOpen, draft: chatDraft, setDraft: setChatDraft,
    inputRef: chatInputRef, openChat, sendChat, closeChat, pushChatLine,
  } = useChat({ gameApi: gameApiRef, chatEnabled: room.chatEnabled });

  // Touch devices have no keyboard: the controls help must show the joystick/buttons, not key caps.
  useEffect(() => {
    setIsTouch(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  // Offline (no game server reachable): multiplayer is impossible, so lock the player into solo and
  // make it visible in the lobby — the "with friends" button is disabled, never silently no-ops.
  useEffect(() => {
    if (!offline) return;
    soloRef.current = true;
    setSolo(true);
  }, [offline]);

  // First-time players get a random look (persisted so it stays stable); done after mount to avoid a
  // hydration mismatch on the color inputs.
  useEffect(() => {
    if (window.localStorage.getItem(LOOK_KEYS.skin)) return;
    const next = randomLook();
    setLook(next);
    window.localStorage.setItem(LOOK_KEYS.skin, next.skin);
    window.localStorage.setItem(LOOK_KEYS.shirt, next.shirt);
    window.localStorage.setItem(LOOK_KEYS.hair, next.hair);
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
        onRole: (role) => { setIsAdmin(role.admin); setIsModerator(role.moderator); },
        onRoomState: (state) => setRoom(state),
        onPendingApprovals: (pending) => setPendingApprovals(pending),
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
  }, [brand, pushChatLine, pushFeedEntry, setIsAdmin, setIsModerator, setRoom, setPendingApprovals]);

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

  const onNameChange = useCallback((value: string): void => {
    setName(value);
    if (typeof window !== 'undefined') window.localStorage.setItem(NAME_KEY, value);
  }, []);

  const onLookChange = useCallback((part: keyof Appearance, value: string): void => {
    setLook((current) => ({ ...current, [part]: value }));
    if (typeof window !== 'undefined') window.localStorage.setItem(LOOK_KEYS[part], value);
  }, []);

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
    const ownsSession = !!session && session.tenant === brand.id;
    setLoggedIn(ownsSession);
    setLobbyAdmin(ownsSession && session?.is_admin === true);
    setLobbyModerator(ownsSession && session?.is_moderator === true);
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
  }, [adminOpen, rosterOpen, setAdminOpen]);

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
      const data = (await res.json()) as { ok: boolean; tenant?: string; name?: string; claim?: string; is_admin?: boolean; is_moderator?: boolean };
      if (!data.ok || !data.tenant || !data.name || !data.claim) {
        setLoginError(t('login.error_code'));
        return;
      }
      saveSession({ tenant: data.tenant, name: data.name, claim: data.claim, is_admin: data.is_admin === true, is_moderator: data.is_moderator === true });
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
      }).catch((error) => warn('api', 'logout request failed', { error: String(error) }));
    }
    clearSession();
    loginClearedRef.current = false;
    setLoggedIn(false);
  }, []);

  return {
    brand, failed, offline, offlineDismissed, setOfflineDismissed,
    name, look, solo, setSolo, soloRef,
    netState, ping, online,
    roster, rosterOpen, setRosterOpen,
    debugOpen, setDebugOpen, debugData,
    loginStep, loginEmail, setLoginEmail, loginCode, setLoginCode, loginBusy, loginError,
    authToast, loggedIn, lobbyAdmin, lobbyModerator, isTouch,
    infiniteResources, setInfiniteResources,
    gameApiRef,
    feed, room, isAdmin, isModerator, adminOpen, setAdminOpen, resetArmed, resetWorld,
    toggleRoomPeace, toggleStructure, toggleRoomPvp, toggleRoomChat, kickPlayer, banPlayer, setRole,
    pendingApprovals, toggleApprovalRequired, approvePlayer,
    chatLines, chatOpen, chatDraft, setChatDraft, chatInputRef, openChat, sendChat, closeChat,
    onNameChange, onLookChange, requestCode, verifyCode, logout, playAsGuest, discardName,
  };
}
