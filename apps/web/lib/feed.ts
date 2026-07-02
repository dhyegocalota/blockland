// Pure helpers for the multiplayer event feed: diff successive rosters into join/leave events, and
// keep the visible feed small and spam-free. coop.ts derives the raw transitions; Game.tsx folds
// them into the visible list. No three.js / DOM here — just data, so it is fully unit-tested.

export type FeedEventKind = 'join' | 'leave' | 'chat' | 'rename' | 'kill' | 'pvp_kill' | 'reset' | 'reset_scores' | 'clear_history' | 'server_down' | 'admin' | 'approval';

export interface FeedEvent {
  kind: FeedEventKind;
  name: string;
  text?: string;
  detail?: string;
  // A private, only-you notice pushed by the local client (never broadcast), rendered with a distinct
  // "só você"/"only you" marker so the admin knows nobody else saw it — e.g. confirming a history clear.
  self?: boolean;
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

export interface PendingMember {
  accountId: string;
  name: string;
}

// Account ids present now but not in the already-seen set are freshly held players awaiting approval;
// each becomes one `approval` event carrying the name and the accountId (in `detail`) so the feed can
// approve/reject it. Resolved approvals simply drop out of `next` and never re-fire.
export function diffPendingApprovals(seenIds: Set<string>, next: PendingMember[]): FeedEvent[] {
  return next
    .filter((member) => !seenIds.has(member.accountId))
    .map((member) => ({ kind: 'approval', name: member.name, detail: member.accountId }));
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
