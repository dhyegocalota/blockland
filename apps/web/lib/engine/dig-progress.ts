// Offline dig progress, pure: count taps against the cell being chipped, resetting when the player
// switches to a different cell, and report when enough taps have landed to break it. Mirrors the Rust
// server's authoritative tap counting so an offline dig takes exactly as many taps as a co-op dig.
//
// NB: DEFERRED dedup — offline digs could be routed through the WASM core's input (room.rs `on_dig`) to
// drop this mirror entirely, but that's a riskier offline-path change that was postponed. Until then,
// keep the tap counting identical to the Rust side.

export interface Chip {
  x: number;
  y: number;
  z: number;
  taps: number;
}

export function chipTap(
  { chip, x, y, z, digHits }: { chip: Chip | null; x: number; y: number; z: number; digHits: number },
): { chip: Chip | null; broke: boolean } {
  const switched = !chip || chip.x !== x || chip.y !== y || chip.z !== z;
  const taps = (switched ? 0 : chip.taps) + 1;
  if (taps < digHits) return { chip: { x, y, z, taps }, broke: false };
  return { chip: null, broke: true };
}
