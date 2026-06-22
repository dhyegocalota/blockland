// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GameApi } from '../game-engine';
import { useChat } from './use-chat';

function gameApiRef(sendChat = vi.fn()) {
  const ref = createRef<GameApi>() as { current: GameApi | null };
  ref.current = { sendChat } as unknown as GameApi;
  return { ref, sendChat };
}

describe('useChat', () => {
  it('appends incoming lines via pushChatLine', () => {
    const { ref } = gameApiRef();
    const { result } = renderHook(() => useChat({ gameApi: ref, chatEnabled: true }));

    act(() => result.current.pushChatLine('Maria', 'hello'));

    expect(result.current.lines.map((line) => line.text)).toEqual(['hello']);
  });

  it('sends a trimmed draft to the engine and clears the input', () => {
    const { ref, sendChat } = gameApiRef();
    const { result } = renderHook(() => useChat({ gameApi: ref, chatEnabled: true }));

    act(() => result.current.setDraft('  hi  '));
    act(() => result.current.sendChat());

    expect(sendChat).toHaveBeenCalledWith('hi');
    expect(result.current.draft).toBe('');
    expect(result.current.open).toBe(false);
  });

  it('closes and clears the draft when chat is disabled', () => {
    const { ref } = gameApiRef();
    const { result, rerender } = renderHook(({ enabled }) => useChat({ gameApi: ref, chatEnabled: enabled }), {
      initialProps: { enabled: true },
    });

    act(() => result.current.openChat());
    expect(result.current.open).toBe(true);

    rerender({ enabled: false });
    expect(result.current.open).toBe(false);
  });
});
