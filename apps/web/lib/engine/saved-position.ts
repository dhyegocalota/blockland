// Persisting where the player last stood (per tenant) so re-entering drops them back there instead
// of spawn. The localStorage read/write stays in the glue; the parsing, validation and serialization
// are pure here so a malformed or partial stored value can never resurrect the player at NaN.

export interface SavedPosition {
  x: number;
  y: number;
  z: number;
}

export function parseSavedPosition(raw: string | null): SavedPosition | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isNumberVector(parsed)) return null;
  return { x: parsed.x, y: parsed.y, z: parsed.z };
}

export function serializeSavedPosition(position: SavedPosition): string {
  return JSON.stringify({ x: position.x, y: position.y, z: position.z });
}

function isNumberVector(value: unknown): value is SavedPosition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === 'number' && typeof candidate.y === 'number' && typeof candidate.z === 'number';
}
