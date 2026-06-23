// Pure builders for the single-player event feed. Online, the server emits these events and coop.ts
// folds them in; offline there is no server, so the engine builds the same FeedEvent shapes here and
// routes them through the existing hud.onEvent seam. A nameless guest is labelled with feed.you so the
// feed never renders a blank actor.
import { t } from '../../i18n';
import type { FeedEvent } from '../../feed';

function selfName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return t('feed.you');
  return trimmed;
}

export function offlineKillFeed(args: { name: string; creatureName: string }): FeedEvent {
  return { kind: 'kill', name: selfName(args.name), detail: args.creatureName };
}

export function offlineResetFeed(args: { name: string }): FeedEvent {
  return { kind: 'reset', name: selfName(args.name) };
}

// An admin config toggle offline. `action` mirrors the string the server emits online (peace_on,
// peace_off, structure_allowed, structure_blocked, pvp_on, ...) so feedText renders the same
// feed.admin_<action> line in both modes.
export function offlineAdminFeed(args: { name: string; action: string }): FeedEvent {
  return { kind: 'admin', name: selfName(args.name), detail: args.action };
}
