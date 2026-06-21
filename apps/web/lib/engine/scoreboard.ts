// Pure scoreboard formatting + the F3 debug snapshot rounding. The DOM writes and the live engine
// values (fps, coop ping) stay in the glue; turning those numbers into the strings shown on the HUD
// is here and unit-tested.

export const FULL_HEART = '❤️';
export const EMPTY_HEART = '🖤';

export function heartsLabel({ hearts, maxHearts }: { hearts: number; maxHearts: number }): string {
  return FULL_HEART.repeat(hearts) + EMPTY_HEART.repeat(maxHearts - hearts);
}

// The best score shown on the live HUD is the higher of the live run and the stored record.
export function bestScore({ stars, stored }: { stars: number; stored: number }): number {
  return Math.max(stars, stored);
}

// The persisted lobby record only ever rises with the server-authoritative co-op score, so solo
// play that inflates the live run locally can never push it past what the leaderboard shows.
export function persistedRecord({ serverScore, stored }: { serverScore: number; stored: number }): number {
  return Math.max(serverScore, stored);
}

// Two-decimal rounding for the debug overlay coordinates.
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}
