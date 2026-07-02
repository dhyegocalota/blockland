// Tiny browser-cookie helper shared by the locale switcher and the LGPD cookie-consent banner: read a
// named cookie and write one that survives a year, lax-scoped to the whole site. Pure string work,
// unit-tested; the only side effect is touching document.cookie behind a window guard.
export const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

export function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
