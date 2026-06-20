import { useCallback, useRef, useState } from 'react';
import { pushFeed, type FeedEntry, type FeedEvent } from '../feed';
import { CHAT_FADE_MS } from '../chat';

// Owns the transient multiplayer event feed: folds incoming events into the capped, dedup'd list
// (pushFeed) and fades each entry out after a delay. `pushFeedEntry` is handed to the engine bridge.
export function useFeed() {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const nextEntryId = useRef(0);

  const pushFeedEntry = useCallback((event: FeedEvent) => {
    const id = nextEntryId.current++;
    setEntries((current) => pushFeed({ entries: current, event, id, now: Date.now() }));
    setTimeout(() => setEntries((current) => current.filter((entry) => entry.id !== id)), CHAT_FADE_MS);
  }, []);

  return { entries, pushFeedEntry };
}
