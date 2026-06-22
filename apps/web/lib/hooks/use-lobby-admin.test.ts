// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLobbyAdmin } from './use-lobby-admin';

vi.mock('../net', () => ({ createNet: vi.fn() }));

describe('useLobbyAdmin', () => {
  it('stays idle (no connection) while inactive and exposes the room-admin surface', () => {
    const look = { skin: '#000', shirt: '#111', hair: '#222' };
    const { result } = renderHook(() => useLobbyAdmin({ tenant: 'acme', name: 'Maria', look, active: false }));

    expect(result.current.state).toBeNull();
    expect(result.current.roster).toEqual([]);
    expect(result.current.isAdmin).toBe(false);
    expect(typeof result.current.resetWorld).toBe('function');
  });
});
