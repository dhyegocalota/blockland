// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

async function mountWithBridge(): Promise<{ result: ReturnType<typeof renderHook<ReturnType<typeof useGame>, unknown>>['result']; bridge: CoopBridge }> {
  initGame.mockClear();
  const { result } = renderHook(() => useGame());
  await waitFor(() => expect(result.current.brand).not.toBeNull());
  await waitFor(() => expect(initGame).toHaveBeenCalled());
  return { result, bridge: initGame.mock.calls[0][1] as CoopBridge };
}

describe('useGame', () => {
  it('mounts without throwing and exposes the game screen surface', async () => {
    const { result } = renderHook(() => useGame());
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.requestCode).toBe('function');
    expect(result.current.lobby).toBeDefined();
    await waitFor(() => expect(result.current.brand).not.toBeNull());
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
});
