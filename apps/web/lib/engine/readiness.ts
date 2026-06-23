// Pure decision for "is the world interactive yet?" — used to gate input and show a connecting
// overlay right after the player presses Play. Offline is interactive the moment the engine starts;
// online additionally needs the socket open, the Welcome received, and the first Snapshot applied, so
// early clicks aren't silently dropped against a server that hasn't acknowledged the join yet.
import type { NetState } from '../net';

export interface ReadinessInput {
  offline: boolean;
  started: boolean;
  netState: NetState | null;
  welcomed: boolean;
  firstSnapshot: boolean;
}

export function isInteractive(input: ReadinessInput): boolean {
  if (!input.started) return false;
  if (input.offline) return true;
  if (input.netState !== 'online') return false;
  if (!input.welcomed) return false;
  return input.firstSnapshot;
}

// The connecting overlay's live status key (or null when there is nothing to show). It surfaces a
// stall: a player stuck on "Conectando…" or "Reconectando…" sees it instead of a frozen black screen.
export function connectStatusKey(input: ReadinessInput): string | null {
  if (!input.started) return null;
  if (input.offline) return null;
  if (isInteractive(input)) return null;
  if (input.netState === 'reconnecting') return 'coop.connect_reconnecting';
  if (input.netState === 'online') return 'coop.connect_ready';
  return 'coop.connect_connecting';
}
