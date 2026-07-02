'use client';

// All of the Game screen's state, effects and handlers live here so the component is just markup.
// It owns the lobby/login lifecycle, boots the Three.js engine via a CoopBridge, and composes the
// smaller hooks (chat, feed, room-admin). The returned object is spread into the component.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { resolveTenant, loadCachedTenant, tenantIdFromLocation, type Brand, type Connectivity } from '../lib/tenants';
import { lobbyAdminPanelActive, lobbyModeGates, shouldPushToOnline, shouldPushToSolo } from '../lib/lobby-modes';
import { t } from '../lib/i18n';
import { debug, warn } from '../lib/log';
import { clearSession, loadSession, resolveClaim, saveSession } from '../lib/session';
import { loadConsent, saveConsent } from '../lib/consent';
import { GAME_ACTIVE_EVENT } from '../lib/cookie-consent';
import { type Settings, loadSettings, updateSettings } from '../lib/settings';
import { type CoopBridge, type DebugSnapshot, type GameApi } from '../lib/game-engine';
import { IDLE_STATE, LoaderPhase, LoaderStage, loaderReducer } from '../lib/engine/loader-state';
import type { Appearance, RoomState, RosterEntry } from '../lib/coop';
import { randomLook } from '../lib/look';
import { CHAT_FADE_MS } from '../lib/chat';
import { diffPendingApprovals } from '../lib/feed';
import { useChat } from './use-chat';
import { useFeed } from './use-feed';
import { useRoomAdmin } from './use-room-admin';
import { useLobbyAdmin } from './use-lobby-admin';
import { useUpdateCheck } from './use-update-check';
import type { NetState } from '../lib/net';
import { connectStatusKey, isInteractive } from '../lib/engine/readiness';

const NAME_KEY = 'bl-name';
const LOOK_KEYS = { skin: 'bl-skin', shirt: 'bl-shirt', hair: 'bl-hair' } as const;
// How often a non-admin lobby player re-resolves the tenant so an admin's runtime mode toggle (and
// server reachability) reaches their start-screen buttons without a manual refresh.
const LOBBY_TENANT_POLL_MS = 8000;
// After the player settles on ONLINE mode on the lobby, warm the WASM core in the background so
// pressing Play later skips the wasm compile. Long enough not to compete with the lobby's first paint.
const WASM_PRELOAD_DELAY_MS = 2500;
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

// The tenant's allowed-mode flags for the lobby gate: the live lobby-admin RoomState when connected,
// the fetched brand otherwise, and a permissive default only while the brand is still loading (the
// start screen that reads this renders only once the brand exists).
function modeFlags({
  brand,
  lobbyConnected,
  lobbyRoom,
}: {
  brand: Brand | null;
  lobbyConnected: boolean;
  lobbyRoom: { onlineAllowed: boolean; offlineAllowed: boolean };
}): { online_allowed: boolean; offline_allowed: boolean } {
  if (lobbyConnected) return { online_allowed: lobbyRoom.onlineAllowed, offline_allowed: lobbyRoom.offlineAllowed };
  if (!brand) return { online_allowed: true, offline_allowed: true };
  return { online_allowed: brand.online_allowed, offline_allowed: brand.offline_allowed };
}

export function useGame() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  // Why the lobby is degraded when the live tenant fetch fails: server down vs the user's internet gone.
  const [connectivity, setConnectivity] = useState<Connectivity>('online');
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [name, setName] = useState(loadName);
  const [look, setLook] = useState<Appearance>(loadLook);
  const [termsAccepted, setTermsAccepted] = useState(loadConsent);
  const [solo, setSolo] = useState(false);
  const [netState, setNetState] = useState<NetState | null>(null);
  const [ping, setPing] = useState(0);
  const [online, setOnline] = useState(1);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<DebugSnapshot | null>(null);
  const [debugCopied, setDebugCopied] = useState(false);
  const [loginStep, setLoginStep] = useState<LoginStep | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [authToast, setAuthToast] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [lobbyAdmin, setLobbyAdmin] = useState(false);
  const [lobbyModerator, setLobbyModerator] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [infiniteResources, setInfiniteResources] = useState(true);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [started, setStarted] = useState(false);
  // Online readiness signals for the connecting overlay: Welcome received (socket acknowledged the
  // join) and the first Snapshot applied (the world is actually live). Until both land, early
  // break/build/hit clicks would be silently dropped, so the overlay gates input on them.
  const [welcomed, setWelcomed] = useState(false);
  const [firstSnapshot, setFirstSnapshot] = useState(false);
  // The code-split engine + wasm core load behind an on-brand loader the moment the player presses
  // Play (the lobby itself never pulls three.js / wasm). This drives that loading screen.
  const [loaderState, dispatchLoader] = useReducer(loaderReducer, IDLE_STATE);

  const gameApiRef = useRef<GameApi | null>(null);
  const engineCleanupRef = useRef<(() => void) | undefined>(undefined);
  const engineRequestedRef = useRef(false);
  const soloRef = useRef(false);
  // The lobby admin's live RoomState, captured for the engine bridge (read at game start). Holds the
  // config only while the lobby-admin connection is live, null otherwise — the offline game seeds its
  // room from it instead of the hardcoded defaults.
  const lobbyRoomRef = useRef<RoomState | null>(null);
  const loginClearedRef = useRef(false);
  const suspendedRef = useRef(false);
  const seenApprovalsRef = useRef<Set<string>>(new Set());

  const { entries: feed, pushFeedEntry, clearFeed } = useFeed();
  const {
    room, setRoom, isAdmin, setIsAdmin, isModerator, setIsModerator, adminOpen, setAdminOpen,
    resetArmed, resetWorld, resetScoresArmed, resetScores, clearHistoryArmed, clearHistory, toggleRoomPeace, toggleStructure, toggleRoomPvp, toggleRoomChat,
    kickPlayer, banPlayer, setRole, suspendRoom,
    pendingApprovals, setPendingApprovals, toggleApprovalRequired, approvePlayer, rejectPlayer, banPending,
    bans, setBans, unban, setLimits, toggleOnlineAllowed, toggleOfflineAllowed,
  } = useRoomAdmin(gameApiRef);
  const updateRequired = useUpdateCheck();
  // The lobby-admin connection stays live for an admin/moderator until the game starts (the panel must
  // keep working after they disable a mode), and never when the server is unreachable (it couldn't
  // connect). It is no longer gated on `solo`, so disabling online never tears the panel's connection.
  const lobbyAdminActive = lobbyAdminPanelActive({ isLobbyAdmin: lobbyAdmin || lobbyModerator, started }) && !offline;
  const lobby = useLobbyAdmin({
    tenant: brand ? brand.id : null,
    name,
    look,
    active: lobbyAdminActive,
  });
  const {
    lines: chatLines, open: chatOpen, draft: chatDraft, setDraft: setChatDraft,
    inputRef: chatInputRef, openChat, sendChat, closeChat, pushChatLine,
  } = useChat({ gameApi: gameApiRef, chatEnabled: room.chatEnabled });

  // Mirror the lobby admin's live room into a ref the engine bridge reads at game start: only while the
  // lobby-admin connection is live (else null), so a non-admin offline game keeps the engine defaults.
  useEffect(() => {
    lobbyRoomRef.current = lobbyAdminActive ? lobby.room : null;
  }, [lobbyAdminActive, lobby.room]);

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

  // Which start-mode buttons the tenant allows. The flags come from the tenant fetched before joining
  // (brand); once the headless lobby-admin connection is live, its RoomState carries any runtime change
  // an admin makes, so prefer it. Server-unreachable (offline) forces online off regardless.
  const lobbyConnected = lobbyAdmin || lobbyModerator;
  const modeGates = useMemo(() => {
    const flags = modeFlags({ brand, lobbyConnected, lobbyRoom: lobby.room });
    return lobbyModeGates({ tenant: flags, serverUnreachable: offline, isAdmin: lobbyAdmin });
  }, [brand, offline, lobbyConnected, lobbyAdmin, lobby.room.onlineAllowed, lobby.room.offlineAllowed]);

  // Keep the chosen mode valid: if the picked mode is blocked, fall to the allowed one. When online is
  // blocked the player is pushed to solo; when offline is blocked (and online is fine) to multiplayer. A
  // lobby admin/moderator is never pushed — they keep the panel connected to re-enable a disabled mode.
  useEffect(() => {
    const isLobbyAdmin = lobbyAdmin || lobbyModerator;
    if (shouldPushToSolo({ gates: modeGates, alreadySolo: soloRef.current, isLobbyAdmin })) {
      soloRef.current = true;
      setSolo(true);
      return;
    }
    if (shouldPushToOnline({ gates: modeGates, alreadySolo: soloRef.current, isLobbyAdmin })) {
      soloRef.current = false;
      setSolo(false);
    }
  }, [modeGates, lobbyAdmin, lobbyModerator]);

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
    // Paint the lobby INSTANTLY from the last-known tenant (no network wait), then revalidate. So a
    // return visit is fast and the lobby still works when the server is down.
    const cached = loadCachedTenant(tenantIdFromLocation());
    if (cached) setBrand(cached);
    resolveTenant()
      .then(({ tenant: active, connectivity: conn }) => {
        if (!alive) return;
        debug('tenant', 'active tenant', { id: active.id, name: active.name, connectivity: conn });
        setBrand(active);
        setOffline(conn !== 'online');
        setConnectivity(conn);
      })
      .catch((err) => {
        if (!alive) return;
        warn('tenant', 'failed to load tenant', { error: String(err) });
        // Only surface the hard error screen when there is no cached tenant to fall back to.
        if (!cached) setFailed(true);
      });
    return () => { alive = false; };
  }, []);

  // A non-admin lobby player holds no live connection, so the tenant's allowed-mode flags (an admin can
  // flip at runtime) and server reachability would otherwise stay frozen at page load. Re-resolve them
  // on an interval while on the start screen so a re-enabled mode lights its button up live (and a
  // recovered server re-enables online). Admins get this instantly over the lobby-admin socket, so they
  // skip the poll; a transient failure keeps the last good value instead of surfacing the error screen.
  const tenantReady = brand !== null;
  useEffect(() => {
    if (started || !tenantReady || lobbyConnected) return;
    let alive = true;
    async function refresh(): Promise<void> {
      try {
        const { tenant: active, connectivity: conn } = await resolveTenant();
        if (!alive) return;
        setBrand(active);
        setOffline(conn !== 'online');
        setConnectivity(conn);
      } catch (error) {
        debug('tenant', 'lobby tenant refresh failed; keeping last', { error: String(error) });
      }
    }
    const timer = setInterval(refresh, LOBBY_TENANT_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [started, tenantReady, lobbyConnected]);

  // Warm the WASM core a few seconds after the player has settled on ONLINE mode, so pressing Play later
  // skips the wasm compile (the engine's loadWorldgen finds it already inited). The loader is loaded by a
  // dynamic import so three.js never enters the lobby bundle; warming is idempotent and failures are silent.
  useEffect(() => {
    if (started || solo || !tenantReady) return;
    const timer = setTimeout(() => {
      import('../lib/engine/online/wasm-core-loader')
        .then((mod) => mod.loadWorldgen())
        .then(() => debug('engine', 'wasm core warmed for online entry'))
        .catch((error) => debug('engine', 'wasm warm failed', { error: String(error) }));
    }, WASM_PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [started, solo, tenantReady]);

  // The engine's HUD bridge: stable callbacks the running game pushes net/roster/admin state through.
  // Built lazily (not on lobby render) so nothing here forces the heavy engine into the lobby bundle.
  const makeBridge = useCallback((activeBrand: Brand): CoopBridge => ({
    resolveName: () => loadName().trim(),
    resolveAppearance: () => loadLook(),
    resolveClaim: (resolvedName) => resolveClaim(activeBrand.id, resolvedName),
    resolveOffline: () => soloRef.current,
    resolveInitialRoom: () => lobbyRoomRef.current,
    hud: {
      onState: (state) => {
        setNetState(state);
        if (state === 'online') setWelcomed(true);
        debug('coop', 'net state', { state });
      },
      onPing: (value) => setPing(value),
      onChat: (from, text) => pushChatLine(from, text),
      onCount: (count) => { setFirstSnapshot(true); setOnline(count); },
      onRoster: (players) => setRoster(players),
      onEvent: (event) => {
        if (event.kind === 'reset_scores') gameApiRef.current?.chime();
        pushFeedEntry(event);
      },
      onClearFeed: () => clearFeed(),
      // Score is authoritative from the snapshot; the engine paints the topbar star/record DOM.
      onScore: () => undefined,
      onRole: (role) => { setIsAdmin(role.admin); setIsModerator(role.moderator); },
      onRoomState: (state) => {
        if (state.suspended && !suspendedRef.current) gameApiRef.current?.chime();
        suspendedRef.current = state.suspended;
        setRoom(state);
      },
      onPendingApprovals: (pending) => {
        const fresh = diffPendingApprovals(seenApprovalsRef.current, pending);
        fresh.forEach((event) => pushFeedEntry(event));
        seenApprovalsRef.current = new Set(pending.map((entry) => entry.accountId));
        setPendingApprovals(pending);
        debug('coop', 'pending approvals (hud)', { count: pending.length, fresh: fresh.length });
      },
      onBans: (bans) => setBans(bans),
      onError: (code) => {
        const key = AUTH_ERROR_KEYS[code];
        if (key) setAuthToast(t(key));
        debug('coop', 'error (hud)', { code, toast: key ? true : false });
      },
    },
    bind: (api) => { gameApiRef.current = api; },
  }), [pushChatLine, pushFeedEntry, clearFeed, setIsAdmin, setIsModerator, setRoom, setPendingApprovals, setBans]);

  // Pressing Play dynamically imports the code-split engine (stage 'engine'), builds it — which inits
  // the wasm core + generates the world (stage 'world') — then re-clicks Play so the engine's own start
  // listener hides the lobby and reveals the live world (loader → ready, fading out). On failure the
  // loader swaps to an on-brand retry message instead of leaving a blank screen.
  const bootEngine = useCallback(async (): Promise<void> => {
    if (!brand) return;
    if (engineRequestedRef.current) return;
    engineRequestedRef.current = true;
    dispatchLoader({ kind: 'start' });
    try {
      const mod = await import('../lib/game-engine');
      debug('engine', 'engine module loaded', { id: brand.id, name: brand.name });
      dispatchLoader({ kind: 'stage', stage: LoaderStage.World });
      engineCleanupRef.current = await mod.initGame(brand, makeBridge(brand));
      dispatchLoader({ kind: 'ready' });
      document.getElementById('playBtn')?.click();
      debug('engine', 'world ready', { id: brand.id, mode: soloRef.current ? 'offline' : 'online' });
    } catch (error) {
      engineRequestedRef.current = false;
      dispatchLoader({ kind: 'fail' });
      warn('engine', 'engine boot failed', { error: String(error) });
    }
  }, [brand, makeBridge]);

  const retryStart = useCallback((): void => {
    dispatchLoader({ kind: 'retry' });
    bootEngine();
  }, [bootEngine]);

  // Tear the running engine down on unmount (the engine itself owns its in-session cleanup).
  useEffect(() => () => { engineCleanupRef.current?.(); }, []);

  // Tell the site-wide cookie banner when play starts so an undecided banner hides during the game
  // instead of covering the HUD (leaving the world reloads back to the lobby, where it shows again).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(GAME_ACTIVE_EVENT, { detail: started }));
  }, [started]);

  // Leaving the world (Exit button, Q, "back to lobby"): close the coop socket cleanly BEFORE reloading
  // so the server drops the avatar immediately, instead of relying on the reload racing the pagehide
  // close. Runs the engine's own cleanup (which calls coop.close()), then reloads back to the lobby.
  const leaveWorld = useCallback((): void => {
    engineCleanupRef.current?.();
    engineCleanupRef.current = undefined;
    window.location.reload();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.code === 'F3') { event.preventDefault(); setDebugOpen((open) => !open); return; }
      if (chatOpen) return;
      const typingTarget = event.target instanceof HTMLInputElement;
      if (typingTarget) return;
      // In-game: Tab toggles the online-players list (a scoreboard), like an FPS. On the start screen
      // (not started) Tab is left alone so it still navigates the form.
      if (event.code === 'Tab' && started) { event.preventDefault(); setRosterOpen((open) => !open); return; }
      if (event.code === 'KeyH' && started) { event.preventDefault(); gameApiRef.current?.returnToSpawn(); return; }
      // Q leaves the world (mirrors the Exit button): disconnect and reload back to the lobby.
      if (event.code === 'KeyQ' && started) { event.preventDefault(); leaveWorld(); return; }
      // Esc closes the admin/moderator panel and re-locks the canvas (the panel freed the cursor on open).
      if (event.code === 'Escape' && started && adminOpen) { event.preventDefault(); setAdminOpen(false); return; }
      // The admin/moderator panel toggle (the player has no panel, so the key does nothing for them).
      if (event.code === 'KeyM' && started && (isAdmin || isModerator)) { event.preventDefault(); setAdminOpen((open) => !open); return; }
      if (event.code === 'Enter' || event.code === 'KeyT') { event.preventDefault(); openChat(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatOpen, openChat, started, isAdmin, isModerator, adminOpen, setAdminOpen, leaveWorld]);


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

  // Copy the engine's plain-text debug report to the clipboard; if the async clipboard write is blocked
  // (insecure context, denied permission) fall back to selecting it in an off-screen textarea so the
  // owner can copy manually. Either way flash "copied" briefly.
  const flashCopied = useCallback((): void => {
    setDebugCopied(true);
    setTimeout(() => setDebugCopied(false), CHAT_FADE_MS);
  }, []);

  const copyDebugReport = useCallback(async (): Promise<void> => {
    const api = gameApiRef.current;
    if (!api) return;
    const report = api.debugReport();
    try {
      await navigator.clipboard.writeText(report);
      debug('coop', 'debug report copied', { length: report.length });
      flashCopied();
      return;
    } catch (error) {
      warn('coop', 'clipboard write failed, selecting for manual copy', { error: String(error) });
    }
    const area = document.createElement('textarea');
    area.value = report;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    flashCopied();
  }, [flashCopied]);

  const onNameChange = useCallback((value: string): void => {
    setName(value);
    if (typeof window !== 'undefined') window.localStorage.setItem(NAME_KEY, value);
  }, []);

  const onLookChange = useCallback((part: keyof Appearance, value: string): void => {
    setLook((current) => ({ ...current, [part]: value }));
    if (typeof window !== 'undefined') window.localStorage.setItem(LOOK_KEYS[part], value);
  }, []);

  // Ticking "I agree to the Terms and Privacy Policy" unlocks Play; the choice is remembered per device
  // so a returning player is not asked again.
  const acceptTerms = useCallback((accepted: boolean): void => {
    setTermsAccepted(accepted);
    saveConsent(accepted);
  }, []);

  // A settings slider/toggle change persists to the live store (the engine reads it next frame/cue) and
  // mirrors the clamped result back into React state so the panel shows what was actually stored. The
  // ⚙ gear + Resume buttons open/close the panel through the engine (id-wired, like the controls modal),
  // so opening/closing is not a React concern here.
  const onSettingChange = useCallback((patch: Partial<Settings>): void => {
    setSettings(updateSettings(patch));
  }, []);

  // Owning a NAME is an ONLINE concern: claiming it on the server (anti-impersonation + ranking) is the
  // only reason auth is needed, so only a named ONLINE player with no valid claim must log in. Offline
  // (solo or server-unreachable) the name is a local label only — a named player boots straight in, and
  // an anonymous guest (empty name) never logs in either way.
  const needsLogin = useCallback((): boolean => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (!brand) return false;
    if (solo || offline) return false;
    return resolveClaim(brand.id, trimmed) === '';
  }, [brand, name, solo, offline]);

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

  // Play actually starting the game tears down the headless lobby admin connection so it never
  // collides with the in-game coop socket on the same claim. The gate above stops propagation when a
  // login is still needed, so this bubble-phase listener only fires when the engine truly boots. The
  // first click loads the engine behind the loader; bootEngine re-clicks once built, and is guarded so
  // that second click is a no-op (only the engine's own start listener acts on it).
  useEffect(() => {
    if (!brand) return;
    const tenantId = brand.id;
    const playBtn = document.getElementById('playBtn');
    if (!playBtn) return;
    function onStart(): void {
      setStarted(true);
      setWelcomed(false);
      setFirstSnapshot(false);
      debug('coop', 'mode entry', { mode: soloRef.current ? 'offline' : 'online', name: loadName().trim(), tenant: tenantId });
      bootEngine();
    }
    playBtn.addEventListener('click', onStart);
    return () => playBtn.removeEventListener('click', onStart);
  }, [brand, bootEngine]);

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

  // A claim the server rejects on the lobby (invalid, expired, or taken over by a newer login) can't be
  // retried: drop the session, release the name and fall back to the logged-out lobby at once.
  const deauthenticate = useCallback(() => {
    clearSession();
    discardName();
    setLoggedIn(false);
    setLobbyAdmin(false);
    setLobbyModerator(false);
  }, [discardName]);

  useEffect(() => {
    if (!lobby.claimInvalid) return;
    if (!loggedIn) return;
    warn('coop', 'lobby claim invalid — deauthenticating and releasing the name');
    deauthenticate();
  }, [lobby.claimInvalid, loggedIn, deauthenticate]);

  const playAsGuest = useCallback(() => {
    discardName();
    loginClearedRef.current = true;
    document.getElementById('playBtn')?.click();
  }, [discardName]);

  // Keep the entered name (a local label) and boot OFFLINE immediately — owning the name on the server
  // is the online-only concern, so this skips auth entirely. Forces the solo/offline path and clears
  // the login modal before re-firing Play so the engine boots single-player with that name.
  const playOffline = useCallback(() => {
    soloRef.current = true;
    setSolo(true);
    loginClearedRef.current = true;
    setLoginError(null);
    setLoginStep(null);
    debug('coop', 'play offline from login', { name: name.trim() });
    document.getElementById('playBtn')?.click();
  }, [name]);

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
        body: JSON.stringify({ tenant: brand.id, name: name.trim(), email: loginEmail.trim(), turnstileToken }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        if (data.error === 'turnstile') setLoginError(t('login.error_turnstile'));
        else setLoginError(t(data.error === 'not_owner' ? 'login.error_not_owner' : 'login.error_invalid'));
        return;
      }
      setLoginStep('code');
    } catch {
      setLoginError(t('login.error_generic'));
    } finally {
      setLoginBusy(false);
    }
  }, [brand, name, loginEmail, turnstileToken]);

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

  // Single-player (chosen solo or server-unreachable) is interactive the moment the engine starts;
  // online waits for the socket + Welcome + first snapshot. The overlay reads connectKey for its live
  // status text and only shows while connecting (key non-null), gating early clicks until ready.
  const readiness = { offline: solo || offline, started, netState, welcomed, firstSnapshot };
  const interactive = isInteractive(readiness);
  const connectKey = connectStatusKey(readiness);

  // Free the cursor whenever a panel or a blocking modal sits over the live game — the admin panel, or
  // any connecting / reconnecting / waiting-for-approval / time-up overlay (all of which make the game
  // non-interactive). The engine exits pointer lock so the modal is usable and suppresses the settings-
  // on-lock-lost pause; once nothing blocks it (interactive again, panel closed), it re-locks the canvas.
  useEffect(() => {
    if (!started) return;
    gameApiRef.current?.setCursorOverlay(adminOpen || !interactive);
  }, [adminOpen, interactive, started]);

  return {
    brand, failed, offline, connectivity, offlineDismissed, setOfflineDismissed,
    name, look, solo, setSolo, soloRef, modeGates,
    loaderState, retryStart,
    netState, ping, online, interactive, connectKey,
    roster, rosterOpen, setRosterOpen,
    debugOpen, setDebugOpen, debugData, debugCopied, copyDebugReport,
    loginStep, loginEmail, setLoginEmail, loginCode, setLoginCode, loginBusy, loginError,
    turnstileToken, setTurnstileToken,
    authToast, loggedIn, lobbyAdmin, lobbyModerator, isTouch,
    infiniteResources, setInfiniteResources,
    settings, onSettingChange,
    lobby,
    gameApiRef,
    feed, room, isAdmin, isModerator, adminOpen, setAdminOpen, resetArmed, resetWorld, resetScoresArmed, resetScores, clearHistoryArmed, clearHistory,
    toggleRoomPeace, toggleStructure, toggleRoomPvp, toggleRoomChat, kickPlayer, banPlayer, setRole, suspendRoom,
    pendingApprovals, toggleApprovalRequired, approvePlayer, rejectPlayer, banPending,
    bans, unban, setLimits, toggleOnlineAllowed, toggleOfflineAllowed, updateRequired,
    chatLines, chatOpen, chatDraft, setChatDraft, chatInputRef, openChat, sendChat, closeChat,
    onNameChange, onLookChange, requestCode, verifyCode, logout, playAsGuest, playOffline, discardName,
    termsAccepted, acceptTerms, leaveWorld,
  };
}
