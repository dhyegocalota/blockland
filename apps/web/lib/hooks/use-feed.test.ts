// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFeed } from './use-feed';

describe('useFeed', () => {
  it('starts empty and appends pushed events with stable ids', () => {
    const { result } = renderHook(() => useFeed());
    expect(result.current.entries).toEqual([]);

    act(() => result.current.pushFeedEntry({ kind: 'join', name: 'Maria' }));
    act(() => result.current.pushFeedEntry({ kind: 'leave', name: 'Joao' }));

    expect(result.current.entries.map((entry) => entry.name)).toEqual(['Maria', 'Joao']);
    expect(result.current.entries[0].id).not.toBe(result.current.entries[1].id);
  });
});
