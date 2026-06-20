// Pure scoreboard formatting + the F3 debug snapshot rounding. The DOM writes and the live engine
// values (fps, coop ping) stay in the glue; turning those numbers into the strings shown on the HUD
// is here and unit-tested.

export const FULL_HEART = '❤️';
export const EMPTY_HEART = '🖤';

export function heartsLabel({ hearts, maxHearts }: { hearts: number; maxHearts: number }): string {
  return FULL_HEART.repeat(hearts) + EMPTY_HEART.repeat(maxHearts - hearts);
}

// The best score is the higher of the live run and the stored record.
export function bestScore({ stars, stored }: { stars: number; stored: number }): number {
  return Math.max(stars, stored);
}

// Two-decimal rounding for the debug overlay coordinates.
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}
