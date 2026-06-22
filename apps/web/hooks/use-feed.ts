import { useCallback, useRef, useState } from 'react';
import { pushFeed, type FeedEntry, type FeedEvent } from '../lib/feed';

// Owns the multiplayer event feed as a persistent rolling log of the last few events (pushFeed caps
// + dedups). It does NOT fade: the server replays a recent backlog on join, so a player who just
// entered still sees what happened — even while nobody was online. `pushFeedEntry` feeds the bridge.
export function useFeed() {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const nextEntryId = useRef(0);

  const pushFeedEntry = useCallback((event: FeedEvent) => {
    const id = nextEntryId.current++;
    setEntries((current) => pushFeed({ entries: current, event, id, now: Date.now() }));
  }, []);

  return { entries, pushFeedEntry };
}
