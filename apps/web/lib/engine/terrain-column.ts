// The standing height of a world column: scan from the top down to the first solid block and return
// the cell just above it (where a creature's feet rest). The world probe is supplied by the glue;
// the scan is pure here and unit-tested.

import { SIZE_Y } from './constants';

export function groundHeight({ isSolidAt }: { isSolidAt: (y: number) => boolean }): number {
  for (let y = SIZE_Y - 1; y >= 0; y--) if (isSolidAt(y)) return y + 1;
  return 0;
}
