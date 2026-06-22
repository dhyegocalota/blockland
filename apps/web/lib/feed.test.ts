import { describe, expect, it } from 'vitest';
import { FEED_DEDUPE_MS, FEED_VISIBLE, diffPendingApprovals, diffRoster, pushFeed, type FeedEntry } from './feed';

describe('diffRoster', () => {
  it('reports joiners present only in the next roster', () => {
    const events = diffRoster([{ id: 1, name: 'Ana' }], [{ id: 1, name: 'Ana' }, { id: 2, name: 'Beto' }]);
    expect(events).toEqual([{ kind: 'join', name: 'Beto' }]);
  });

  it('reports leavers gone from the next roster', () => {
    const events = diffRoster([{ id: 1, name: 'Ana' }, { id: 2, name: 'Beto' }], [{ id: 1, name: 'Ana' }]);
    expect(events).toEqual([{ kind: 'leave', name: 'Beto' }]);
  });

  it('emits nothing when the roster is unchanged', () => {
    const roster = [{ id: 1, name: 'Ana' }];
    expect(diffRoster(roster, roster)).toEqual([]);
  });

  it('reports a join and a leave in the same diff', () => {
    const events = diffRoster([{ id: 1, name: 'Ana' }], [{ id: 2, name: 'Beto' }]);
    expect(events).toEqual([{ kind: 'join', name: 'Beto' }, { kind: 'leave', name: 'Ana' }]);
  });
});

describe('diffPendingApprovals', () => {
  it('emits an approval event for a freshly held player carrying the accountId in detail', () => {
    const events = diffPendingApprovals(new Set(), [{ accountId: 'a1', name: 'Ana' }]);
    expect(events).toEqual([{ kind: 'approval', name: 'Ana', detail: 'a1' }]);
  });

  it('emits nothing for an account already seen', () => {
    const events = diffPendingApprovals(new Set(['a1']), [{ accountId: 'a1', name: 'Ana' }]);
    expect(events).toEqual([]);
  });

  it('emits only the newly held player when the set already has others', () => {
    const events = diffPendingApprovals(new Set(['a1']), [
      { accountId: 'a1', name: 'Ana' },
      { accountId: 'a2', name: 'Beto' },
    ]);
    expect(events).toEqual([{ kind: 'approval', name: 'Beto', detail: 'a2' }]);
  });

  it('emits nothing when the pending list is empty', () => {
    expect(diffPendingApprovals(new Set(['a1']), [])).toEqual([]);
  });
});

describe('pushFeed', () => {
  it('appends a new event with id and timestamp', () => {
    const entries = pushFeed({ entries: [], event: { kind: 'join', name: 'Ana' }, id: 0, now: 100 });
    expect(entries).toEqual([{ kind: 'join', name: 'Ana', id: 0, at: 100 }]);
  });

  it('coalesces an identical consecutive event within the dedupe window', () => {
    const first = pushFeed({ entries: [], event: { kind: 'join', name: 'Ana' }, id: 0, now: 100 });
    const second = pushFeed({ entries: first, event: { kind: 'join', name: 'Ana' }, id: 1, now: 100 + FEED_DEDUPE_MS - 1 });
    expect(second).toBe(first);
  });

  it('keeps an identical event once the dedupe window has passed', () => {
    const first = pushFeed({ entries: [], event: { kind: 'join', name: 'Ana' }, id: 0, now: 100 });
    const second = pushFeed({ entries: first, event: { kind: 'join', name: 'Ana' }, id: 1, now: 100 + FEED_DEDUPE_MS });
    expect(second).toHaveLength(2);
  });

  it('does not coalesce a different name', () => {
    const first = pushFeed({ entries: [], event: { kind: 'join', name: 'Ana' }, id: 0, now: 100 });
    const second = pushFeed({ entries: first, event: { kind: 'join', name: 'Beto' }, id: 1, now: 110 });
    expect(second).toHaveLength(2);
  });

  it('does not coalesce a different kind', () => {
    const first = pushFeed({ entries: [], event: { kind: 'join', name: 'Ana' }, id: 0, now: 100 });
    const second = pushFeed({ entries: first, event: { kind: 'leave', name: 'Ana' }, id: 1, now: 110 });
    expect(second).toHaveLength(2);
  });

  it('appends a rename system event carrying the old name in detail', () => {
    const entries = pushFeed({ entries: [], event: { kind: 'rename', name: 'Bea', detail: 'Ana' }, id: 0, now: 100 });
    expect(entries).toEqual([{ kind: 'rename', name: 'Bea', detail: 'Ana', id: 0, at: 100 }]);
  });

  it('does not coalesce two renames of the same player with different old names', () => {
    const first = pushFeed({ entries: [], event: { kind: 'rename', name: 'Bea', detail: 'Ana' }, id: 0, now: 100 });
    const second = pushFeed({ entries: first, event: { kind: 'rename', name: 'Bea', detail: 'Cris' }, id: 1, now: 110 });
    expect(second).toHaveLength(2);
  });

  it('appends a reset system event carrying the admin name', () => {
    const entries = pushFeed({ entries: [], event: { kind: 'reset', name: 'Maria' }, id: 0, now: 100 });
    expect(entries).toEqual([{ kind: 'reset', name: 'Maria', id: 0, at: 100 }]);
  });

  it('appends an approval event carrying the accountId in detail', () => {
    const entries = pushFeed({ entries: [], event: { kind: 'approval', name: 'Ana', detail: 'a1' }, id: 0, now: 100 });
    expect(entries).toEqual([{ kind: 'approval', name: 'Ana', detail: 'a1', id: 0, at: 100 }]);
  });

  it('caps the visible list to the last FEED_VISIBLE entries', () => {
    const entries = Array.from({ length: FEED_VISIBLE + 3 }).reduce<FeedEntry[]>(
      (acc, _unused, index) => pushFeed({ entries: acc, event: { kind: 'join', name: `P${index}` }, id: index, now: index }),
      []
    );
    expect(entries).toHaveLength(FEED_VISIBLE);
    expect(entries[0].name).toBe('P3');
  });
});
