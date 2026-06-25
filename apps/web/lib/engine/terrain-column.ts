// The standing height of a world column: scan from the top down to the first solid block and return
// the cell just above it (where a creature's feet rest). The world probe is supplied by the glue;
// the scan is pure here and unit-tested.
//
// NB: this mirrors sim::surface_y but STAYS client-side on purpose — it scans the already-materialized
// TS voxel cache (not a standalone Rust World, which would need the edit overlay passed in), and it is a
// trivial top-down loop. There is no safe/worthwhile way to source it from WASM. Not a dedup candidate.

import { SIZE_Y } from './constants';

export function groundHeight({ isSolidAt }: { isSolidAt: (y: number) => boolean }): number {
  for (let y = SIZE_Y - 1; y >= 0; y--) if (isSolidAt(y)) return y + 1;
  return 0;
}
