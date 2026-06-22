import { describe, expect, it } from 'vitest';
import type { RosterEntry } from './coop';
import { ADMIN_BADGE, MODERATOR_BADGE, badgedNames, roleBadge } from './roster-roles';

function entry(over: Partial<RosterEntry>): RosterEntry {
  return { id: 1, name: 'Maria', self: false, admin: false, moderator: false, ...over };
}

describe('roleBadge', () => {
  it('badges an admin with the crown', () => {
    expect(roleBadge({ admin: true, moderator: false })).toBe(ADMIN_BADGE);
  });

  it('badges a moderator with the kid', () => {
    expect(roleBadge({ admin: false, moderator: true })).toBe(MODERATOR_BADGE);
  });

  it('prefers admin when a player is both admin and moderator', () => {
    expect(roleBadge({ admin: true, moderator: true })).toBe(ADMIN_BADGE);
  });

  it('gives a plain player no badge', () => {
    expect(roleBadge({ admin: false, moderator: false })).toBeNull();
  });
});

describe('badgedNames', () => {
  it('maps only admins/mods to their badge by name', () => {
    const map = badgedNames([
      entry({ id: 1, name: 'Ana', admin: true }),
      entry({ id: 2, name: 'Bia', moderator: true }),
      entry({ id: 3, name: 'Caio' }),
    ]);
    expect(map.get('Ana')).toBe(ADMIN_BADGE);
    expect(map.get('Bia')).toBe(MODERATOR_BADGE);
    expect(map.has('Caio')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('is empty when nobody holds a role', () => {
    expect(badgedNames([entry({ name: 'Caio' })]).size).toBe(0);
  });
});
