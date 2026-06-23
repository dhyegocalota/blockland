// Lightweight, prefixed debug logger for the browser. Debug output is OFF by default and
// turned on with `?debug=1` in the URL or `localStorage.bl-debug = '1'`. Warnings and
// errors always print. Each line is tagged `[BL:<scope>]` for easy filtering.

export type Scope = 'engine' | 'net' | 'coop' | 'action' | 'tenant' | 'i18n' | 'api' | 'pwa' | 'leaderboard' | 'lobby-admin';

export type LogFields = Record<string, unknown>;

const COLORS: Record<Scope, string> = {
  engine: '#6bd06b',
  net: '#3dc6ff',
  coop: '#ff8ad0',
  action: '#ffaf3d',
  tenant: '#ffd23f',
  i18n: '#b06bff',
  api: '#ff8a3d',
  pwa: '#22c55e',
  leaderboard: '#ffd23f',
  'lobby-admin': '#cbb8ff',
};

function debugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).has('debug')) return true;
    return window.localStorage.getItem('bl-debug') === '1';
  } catch {
    return false;
  }
}

function tag(scope: Scope): [string, string] {
  return [`%c[BL:${scope}]`, `color:${COLORS[scope]};font-weight:bold`];
}

export function debug(scope: Scope, message: string, fields?: LogFields): void {
  if (!debugEnabled()) return;
  if (fields === undefined) console.debug(...tag(scope), message);
  else console.debug(...tag(scope), message, fields);
}

export function warn(scope: Scope, message: string, fields?: LogFields): void {
  if (fields === undefined) console.warn(...tag(scope), message);
  else console.warn(...tag(scope), message, fields);
}

export function error(scope: Scope, message: string, fields?: LogFields): void {
  if (fields === undefined) console.error(...tag(scope), message);
  else console.error(...tag(scope), message, fields);
}
