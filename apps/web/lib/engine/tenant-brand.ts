// Pure derivations for the slim tenant model. A tenant carries only `{ id, name, image }`; the
// face-block label and the theme color are derived/defaulted here instead of being stored per tenant.

// The shared Blockland gold, used as the single theme color for every tenant.
export const DEFAULT_BRAND_COLOR = '#ffd23f';

// The in-game face-block label derived from the tenant display name, e.g. "Acme" → "Acme!".
export function faceBlockNameFor(name: string): string {
  return `${name}!`;
}
