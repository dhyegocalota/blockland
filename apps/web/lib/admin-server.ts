// Server-side bridge to the Rust moderation API. The browser hits our /api/admin/* proxies
// (gated by the web admin key via admin-auth); those proxies call here, which attaches the
// server-only ADMIN_TOKEN (x-admin-token) and talks to the server. The token never
// reaches the client, and upstream failures are mapped to a generic error.
import 'server-only';

const DEFAULT_API_URL = 'http://localhost:8080';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export function isValidIp(value: string): boolean {
  const v4 = IPV4.exec(value);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255);
  if (!value.includes(':')) return false;
  return IPV6.test(value);
}

export class AdminUpstreamError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`admin upstream failed (${status})`);
    this.name = 'AdminUpstreamError';
    this.status = status;
  }
}

function baseUrl(): string {
  return process.env.API_URL || DEFAULT_API_URL;
}

function adminToken(): string {
  const value = process.env.ADMIN_TOKEN;
  if (!value) throw new Error('admin-server: ADMIN_TOKEN is not set');
  return value;
}

async function adminFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const hasBody = body !== undefined;
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'x-admin-token': adminToken(),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) throw new AdminUpstreamError(res.status);
  return res.json();
}

export async function fetchOnline(): Promise<unknown> {
  return adminFetch('GET', '/admin/stats');
}

export async function fetchBans(): Promise<unknown> {
  return adminFetch('GET', '/admin/bans');
}

export async function banIp(ip: string): Promise<unknown> {
  return adminFetch('POST', '/admin/ban', { ip });
}

export async function unbanIp(ip: string): Promise<unknown> {
  return adminFetch('POST', '/admin/unban', { ip });
}

export async function fetchAccounts(tenant: string): Promise<unknown> {
  return adminFetch('GET', `/admin/accounts/${encodeURIComponent(tenant)}`);
}

export async function setAccountAdmin(
  args: { tenant: string; admin: boolean } & ({ name: string } | { email: string }),
): Promise<unknown> {
  return adminFetch('POST', '/admin/set-admin', args);
}

export async function setAccountModerator(
  args: { tenant: string; moderator: boolean } & ({ name: string } | { email: string }),
): Promise<unknown> {
  return adminFetch('POST', '/admin/set-moderator', args);
}
