// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RoomAdminApi } from '../lib/game-engine';
import { useRoomAdmin } from './use-room-admin';

function adminRef(api: Partial<RoomAdminApi>) {
  return { current: api as RoomAdminApi };
}

describe('useRoomAdmin', () => {
  it('arms the world reset on the first click and only wipes on confirm', () => {
    const resetWorld = vi.fn();
    const ref = adminRef({ resetWorld });
    const { result } = renderHook(() => useRoomAdmin(ref));

    act(() => result.current.resetWorld());
    expect(result.current.resetArmed).toBe(true);
    expect(resetWorld).not.toHaveBeenCalled();

    act(() => result.current.resetWorld());
    expect(result.current.resetArmed).toBe(false);
    expect(resetWorld).toHaveBeenCalledTimes(1);
  });

  it('toggles room peace through the engine api', () => {
    const setAdminPeace = vi.fn();
    const ref = adminRef({ setAdminPeace });
    const { result } = renderHook(() => useRoomAdmin(ref));

    act(() => result.current.toggleRoomPeace());

    expect(setAdminPeace).toHaveBeenCalledWith(false);
  });
});
