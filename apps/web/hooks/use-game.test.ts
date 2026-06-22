// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/tenants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/tenants')>();
  return { ...actual, resolveTenant: vi.fn().mockRejectedValue(new Error('no tenant')) };
});
vi.mock('../lib/game-engine', () => ({ initGame: vi.fn() }));
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;

import { useGame } from './use-game';

describe('useGame', () => {
  it('mounts without throwing and exposes the game screen surface', async () => {
    const { result } = renderHook(() => useGame());

    expect(result.current.brand).toBeNull();
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.requestCode).toBe('function');
    expect(result.current.lobby).toBeDefined();

    await waitFor(() => expect(result.current.failed).toBe(true));
  });
});
