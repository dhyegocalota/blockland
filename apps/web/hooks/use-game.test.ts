// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoopBridge } from '../lib/engine/api';

vi.mock('../lib/tenants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tenants')>();
  const brand = { id: 't1', name: 'Test', image: '/i.png', online_allowed: true, offline_allowed: true };
  return { ...actual, resolveTenant: vi.fn().mockResolvedValue({ tenant: brand, offline: false }) };
});
const initGame = vi.fn();
vi.mock('../lib/game-engine', () => ({ initGame: (...args: unknown[]) => initGame(...args) }));
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;

import { useGame } from './use-game';

afterEach(() => { cleanup(); document.body.innerHTML = ''; window.localStorage.clear(); });

// The engine now loads on Play, not on mount, so the bridge only exists after the player presses Play.
// A #playBtn node (normally rendered by Game.tsx) is injected and clicked to drive bootEngine.
async function mountWithBridge(): Promise<{ result: ReturnType<typeof renderHook<ReturnType<typeof useGame>, unknown>>['result']; bridge: CoopBridge }> {
  initGame.mockClear();
  const playBtn = document.createElement('button');
  playBtn.id = 'playBtn';
  document.body.appendChild(playBtn);
  const { result } = renderHook(() => useGame());
  await waitFor(() => expect(result.current.brand).not.toBeNull());
  act(() => { playBtn.click(); });
  await waitFor(() => expect(initGame).toHaveBeenCalled());
  return { result, bridge: initGame.mock.calls[0][1] as CoopBridge };
}

// Mount the hook with a #playBtn ready to click (the engine's own start listener lives on it), without
// auto-firing Play — so a test can choose mode/name first and assert the login gate's decision.
async function mountReady(): Promise<{ result: ReturnType<typeof renderHook<ReturnType<typeof useGame>, unknown>>['result']; playBtn: HTMLButtonElement }> {
  initGame.mockClear();
  const playBtn = document.createElement('button');
  playBtn.id = 'playBtn';
  document.body.appendChild(playBtn);
  const { result } = renderHook(() => useGame());
  await waitFor(() => expect(result.current.brand).not.toBeNull());
  return { result, playBtn };
}

describe('useGame', () => {
  it('mounts without throwing and exposes the game screen surface', async () => {
    const { result } = renderHook(() => useGame());
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.requestCode).toBe('function');
    expect(result.current.lobby).toBeDefined();
    await waitFor(() => expect(result.current.brand).not.toBeNull());
  });

  it('does not load the engine on mount — only after Play — and drives the loader to ready', async () => {
    initGame.mockClear();
    const playBtn = document.createElement('button');
    playBtn.id = 'playBtn';
    document.body.appendChild(playBtn);
    const { result } = renderHook(() => useGame());
    await waitFor(() => expect(result.current.brand).not.toBeNull());
    expect(initGame).not.toHaveBeenCalled();
    expect(result.current.loaderState).toEqual({ phase: 'idle' });

    act(() => { playBtn.click(); });
    await waitFor(() => expect(initGame).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.loaderState).toEqual({ phase: 'ready' }));
  });

  it('shows the on-brand retry path when the engine import fails, then recovers on retry', async () => {
    initGame.mockClear();
    initGame.mockImplementationOnce(() => { throw new Error('boom'); });
    const playBtn = document.createElement('button');
    playBtn.id = 'playBtn';
    document.body.appendChild(playBtn);
    const { result } = renderHook(() => useGame());
    await waitFor(() => expect(result.current.brand).not.toBeNull());

    act(() => { playBtn.click(); });
    await waitFor(() => expect(result.current.loaderState).toEqual({ phase: 'error' }));

    act(() => { result.current.retryStart(); });
    await waitFor(() => expect(result.current.loaderState).toEqual({ phase: 'ready' }));
  });

  it('pushes a feed notification and populates the in-game pending list when a guest is held', async () => {
    const { result, bridge } = await mountWithBridge();
    act(() => {
      bridge.hud.onRole({ admin: true, moderator: false });
      bridge.hud.onPendingApprovals([{ accountId: 'ip:1.2.3.4', name: 'Guest', email: '' }]);
    });

    await waitFor(() => {
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.pendingApprovals).toEqual([{ accountId: 'ip:1.2.3.4', name: 'Guest', email: '' }]);
      const approval = result.current.feed.find((entry) => entry.kind === 'approval');
      expect(approval).toMatchObject({ kind: 'approval', name: 'Guest', detail: 'ip:1.2.3.4' });
    });
  });

  it('only fires a feed notification for a newly held guest, not for one already seen', async () => {
    const { result, bridge } = await mountWithBridge();
    const guest = { accountId: 'ip:1.2.3.4', name: 'Guest', email: '' };
    act(() => bridge.hud.onPendingApprovals([guest]));
    await waitFor(() => expect(result.current.feed.filter((entry) => entry.kind === 'approval')).toHaveLength(1));

    act(() => bridge.hud.onPendingApprovals([guest]));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(result.current.feed.filter((entry) => entry.kind === 'approval')).toHaveLength(1);
  });

  it('a named ONLINE player with no claim still gets the login gate (does not boot)', async () => {
    window.localStorage.setItem('bl-name', 'Maria');
    const { result, playBtn } = await mountReady();
    expect(result.current.solo).toBe(false);

    act(() => { playBtn.click(); });
    await waitFor(() => expect(result.current.loginStep).toBe('email'));
    expect(initGame).not.toHaveBeenCalled();
  });

  it('a named SOLO/offline player boots straight in, skipping the login flow', async () => {
    window.localStorage.setItem('bl-name', 'Maria');
    const { result, playBtn } = await mountReady();
    act(() => { result.current.setSolo(true); result.current.soloRef.current = true; });

    act(() => { playBtn.click(); });
    await waitFor(() => expect(initGame).toHaveBeenCalledOnce());
    expect(result.current.loginStep).toBeNull();
  });

  it('playOffline boots offline with the entered name and skips auth', async () => {
    window.localStorage.setItem('bl-name', 'Maria');
    const { result, playBtn } = await mountReady();

    act(() => { playBtn.click(); });
    await waitFor(() => expect(result.current.loginStep).toBe('email'));
    expect(initGame).not.toHaveBeenCalled();

    act(() => { result.current.playOffline(); });
    await waitFor(() => expect(initGame).toHaveBeenCalledOnce());
    expect(result.current.loginStep).toBeNull();
    expect(result.current.solo).toBe(true);
    const bridge = initGame.mock.calls[0][1] as CoopBridge;
    expect(bridge.resolveName()).toBe('Maria');
    expect(bridge.resolveOffline()).toBe(true);
  });

  function pressKey(code: string): void {
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true })); });
  }

  it('the H shortcut returns the player to spawn once the game has started', async () => {
    const { result, bridge } = await mountWithBridge();
    const returnToSpawn = vi.fn();
    act(() => { bridge.bind({ returnToSpawn } as unknown as Parameters<CoopBridge['bind']>[0]); });
    pressKey('KeyH');
    expect(returnToSpawn).toHaveBeenCalledOnce();
  });

  it('the M shortcut toggles the admin panel only for an admin/moderator', async () => {
    const { result, bridge } = await mountWithBridge();
    pressKey('KeyM');
    expect(result.current.adminOpen).toBe(false);

    act(() => { bridge.hud.onRole({ admin: true, moderator: false }); });
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    pressKey('KeyM');
    await waitFor(() => expect(result.current.adminOpen).toBe(true));
    pressKey('KeyM');
    await waitFor(() => expect(result.current.adminOpen).toBe(false));
  });

  it('the Backspace shortcut leaves the world (reloads to the lobby) once started', async () => {
    await mountWithBridge();
    const original = window.location;
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    pressKey('Backspace');
    expect(reload).toHaveBeenCalledOnce();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('opening the admin panel frees the cursor and closing it re-locks (engine cursor overlay)', async () => {
    const { result, bridge } = await mountWithBridge();
    const setCursorOverlay = vi.fn();
    act(() => { bridge.bind({ setCursorOverlay } as unknown as Parameters<CoopBridge['bind']>[0]); });
    act(() => { result.current.setAdminOpen(true); });
    await waitFor(() => expect(setCursorOverlay).toHaveBeenLastCalledWith(true));
    act(() => { result.current.setAdminOpen(false); });
    await waitFor(() => expect(setCursorOverlay).toHaveBeenLastCalledWith(false));
  });

  it('Esc closes the admin/moderator panel when it is open (re-locking the canvas)', async () => {
    const { result } = await mountWithBridge();
    act(() => { result.current.setAdminOpen(true); });
    await waitFor(() => expect(result.current.adminOpen).toBe(true));
    pressKey('Escape');
    await waitFor(() => expect(result.current.adminOpen).toBe(false));
  });

  // Non-admin lobby players have no live socket, so a re-enabled mode must reach them by re-resolving the
  // tenant on an interval. Drive that poll with fake timers and prove the blocked Online button frees up.
  it('re-resolves the tenant on the lobby so a re-enabled online mode lights its button up live', async () => {
    const tenants = await import('../lib/tenants');
    const resolveTenant = vi.mocked(tenants.resolveTenant);
    const brandOf = (online: boolean) => ({
      id: 't1', name: 'Test', image: '/i.png', playtime_limit_min: 0, playtime_window_h: 0, online_allowed: online, offline_allowed: true,
    });
    resolveTenant.mockResolvedValue({ tenant: brandOf(false), offline: false });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useGame());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.brand).not.toBeNull();
      expect(result.current.modeGates.online.disabled).toBe(true);

      resolveTenant.mockResolvedValue({ tenant: brandOf(true), offline: false });
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      expect(result.current.modeGates.online.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
      resolveTenant.mockResolvedValue({ tenant: brandOf(true), offline: false });
    }
  });
});
