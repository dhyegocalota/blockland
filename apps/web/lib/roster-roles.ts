// Role badges for a player in the roster. Admin outranks moderator; a plain player has no badge.
// Shared by the in-game admin panel, the lobby admin panel and the lobby presence line so the
// 👑/🧒 markers stay consistent everywhere.
import type { RosterEntry } from './coop';

export const ADMIN_BADGE = '👑';
export const MODERATOR_BADGE = '🧒';

export function roleBadge(role: { admin: boolean; moderator: boolean }): string | null {
  if (role.admin) return ADMIN_BADGE;
  if (role.moderator) return MODERATOR_BADGE;
  return null;
}

// The online names that carry an admin/mod badge, for the lobby presence line where we only have
// names to match against.
export function badgedNames(roster: RosterEntry[]): Map<string, string> {
  return roster.reduce((badged, player) => {
    const badge = roleBadge(player);
    if (badge) badged.set(player.name, badge);
    return badged;
  }, new Map<string, string>());
}
