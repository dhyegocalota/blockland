// The player must tick "I read and agree to the Terms and Privacy Policy" before the Play button
// unlocks. The acceptance is remembered per device in `bl-consent` (like `bl-name`/`bl-settings`) so a
// returning player is not asked again. Pure load/save round-trip, unit-tested; the lobby reads it into
// state and gates Play on it.
export const CONSENT_KEY = 'bl-consent';

export function loadConsent(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(CONSENT_KEY) === 'true';
}

export function saveConsent(accepted: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CONSENT_KEY, accepted ? 'true' : 'false');
}
