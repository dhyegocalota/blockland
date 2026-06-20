import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { flushSync } from 'react-dom';
import { appendChatLine, dropChatLine, CHAT_BACKLOG, CHAT_FADE_MS, type ChatLine } from '../chat';
import type { GameApi } from '../game-engine';

// Owns the transient chat overlay: the visible lines (capped + auto-fading), the open/draft state,
// and the input focus dance that pops the mobile keyboard. `pushChatLine` is handed to the engine
// bridge so incoming messages land here too.
export function useChat(args: { gameApi: MutableRefObject<GameApi | null>; chatEnabled: boolean }) {
  const { gameApi, chatEnabled } = args;
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const nextLineId = useRef(0);

  const pushChatLine = useCallback((from: string, text: string) => {
    const id = nextLineId.current++;
    setLines((current) => appendChatLine({ lines: current, line: { id, name: from, text }, cap: CHAT_BACKLOG }));
    setTimeout(() => setLines((current) => dropChatLine({ lines: current, id })), CHAT_FADE_MS);
  }, []);

  // Render the input synchronously so focus() runs inside the same user gesture — that's what makes
  // the mobile keyboard pop up immediately.
  const openChat = useCallback(() => {
    if (!chatEnabled) return;
    flushSync(() => setOpen(true));
    inputRef.current?.focus();
  }, [chatEnabled]);

  const sendChat = useCallback(() => {
    const text = draft.trim();
    if (text) gameApi.current?.sendChat(text);
    setDraft('');
    setOpen(false);
  }, [draft, gameApi]);

  const closeChat = useCallback(() => {
    setDraft('');
    setOpen(false);
  }, []);

  // When an admin disables the room chat, close any open input and drop the draft.
  useEffect(() => {
    if (chatEnabled) return;
    setOpen(false);
    setDraft('');
  }, [chatEnabled]);

  return { lines, open, draft, setDraft, inputRef, openChat, sendChat, closeChat, pushChatLine };
}
