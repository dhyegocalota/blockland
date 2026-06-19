// Pure helpers for the multiplayer event feed: diff successive rosters into join/leave events, and
// keep the visible feed small and spam-free. coop.ts derives the raw transitions; Game.tsx folds
// them into the visible list. No three.js / DOM here — just data, so it is fully unit-tested.

export type FeedEventKind = 'join' | 'leave' | 'chat' | 'rename' | 'kill';

export interface FeedEvent {
  kind: FeedEventKind;
  name: string;
  text?: string;
  detail?: string;
}

export interface FeedEntry extends FeedEvent {
  id: number;
  at: number;
}

export const FEED_VISIBLE = 6;
export const FEED_DEDUPE_MS = 2000;

export interface RosterMember {
  id: number;
  name: string;
}

// Players present in `next` but not in `prev` joined; those gone from `prev` left. Self is excluded
// by the caller, so every diff here is a real remote transition.
export function diffRoster(prev: RosterMember[], next: RosterMember[]): FeedEvent[] {
  const prevIds = new Set(prev.map((member) => member.id));
  const nextIds = new Set(next.map((member) => member.id));
  const joins: FeedEvent[] = next
    .filter((member) => !prevIds.has(member.id))
    .map((member) => ({ kind: 'join', name: member.name }));
  const leaves: FeedEvent[] = prev
    .filter((member) => !nextIds.has(member.id))
    .map((member) => ({ kind: 'leave', name: member.name }));
  return [...joins, ...leaves];
}

function isDuplicate(previous: FeedEntry, event: FeedEvent, now: number): boolean {
  if (previous.kind !== event.kind) return false;
  if (previous.name !== event.name) return false;
  if (previous.text !== event.text) return false;
  if (previous.detail !== event.detail) return false;
  return now - previous.at < FEED_DEDUPE_MS;
}

// Append an event, coalescing a burst of identical consecutive events within FEED_DEDUPE_MS (a
// reconnection storm shows one "joined", not five) and capping the list to the last FEED_VISIBLE.
export function pushFeed(args: { entries: FeedEntry[]; event: FeedEvent; id: number; now: number }): FeedEntry[] {
  const { entries, event, id, now } = args;
  const last = entries[entries.length - 1];
  if (last && isDuplicate(last, event, now)) return entries;
  return [...entries, { ...event, id, at: now }].slice(-FEED_VISIBLE);
}
