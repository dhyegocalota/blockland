// Server-side client for the internal data API. Signs every request with the HMAC
// channel contract (METHOD\nPATH\nTS\nNONCE\nSHA256_HEX(BODY)) and proxies to the
// backend; the browser never talks to the database directly.
import 'server-only';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Tenant } from './builtins';

const DEFAULT_API_URL = 'http://localhost:8080';
const NONCE_BYTES = 16;
const DEFAULT_TOP_LIMIT = 10;

export interface ScoreEntry {
  name: string;
  score: number;
}

function secret(): string {
  const value = process.env.INTERNAL_HMAC_SECRET;
  if (!value) throw new Error('api: INTERNAL_HMAC_SECRET is not set');
  return value;
}

function baseUrl(): string {
  return process.env.API_URL || DEFAULT_API_URL;
}

export interface OnlinePresence {
  count: number;
  names: string[];
  suspended: boolean;
}

// Public lobby presence (no HMAC): who and how many are online in a tenant right now.
export async function fetchOnline(tenant: string): Promise<OnlinePresence> {
  const res = await fetch(`${baseUrl()}/online/${encodeURIComponent(tenant)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`online ${res.status}`);
  return (await res.json()) as OnlinePresence;
}

export function sign(params: {
  method: string;
  path: string;
  ts: string;
  nonce: string;
  body: string | Uint8Array<ArrayBuffer>;
}): string {
  const bodyHash =
    typeof params.body === 'string'
      ? createHash('sha256').update(params.body, 'utf8').digest('hex')
      : createHash('sha256').update(params.body).digest('hex');
  const canonical = [params.method, params.path, params.ts, params.nonce, bodyHash].join('\n');
  return createHmac('sha256', secret()).update(canonical, 'utf8').digest('hex');
}

async function signedSend(params: {
  method: string;
  path: string;
  body: string | Uint8Array<ArrayBuffer>;
  contentType: string;
}): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const signature = sign({ method: params.method, path: params.path, ts, nonce, body: params.body });

  return fetch(`${baseUrl()}${params.path}`, {
    method: params.method,
    headers: {
      'x-bl-ts': ts,
      'x-bl-nonce': nonce,
      'x-bl-sig': signature,
      'content-type': params.contentType,
    },
    body: params.body,
    cache: 'no-store',
  });
}

export async function signedFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const hasBody = body !== undefined;
  if (!hasBody) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    const signature = sign({ method, path, ts, nonce, body: '' });
    return fetch(`${baseUrl()}${path}`, {
      method,
      headers: { 'x-bl-ts': ts, 'x-bl-nonce': nonce, 'x-bl-sig': signature },
      cache: 'no-store',
    });
  }
  return signedSend({ method, path, body: JSON.stringify(body), contentType: 'application/json' });
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const res = await signedFetch('GET', `/internal/tenants/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`api: getTenant failed (${res.status})`);
  return (await res.json()) as Tenant;
}

export async function listTenants(): Promise<Tenant[]> {
  const res = await signedFetch('GET', '/internal/tenants');
  if (!res.ok) throw new Error(`api: listTenants failed (${res.status})`);
  return (await res.json()) as Tenant[];
}

export async function upsertTenant(tenant: Tenant): Promise<Tenant> {
  const res = await signedFetch('POST', '/internal/tenants', tenant);
  if (!res.ok) throw new Error(`api: upsertTenant failed (${res.status})`);
  return (await res.json()) as Tenant;
}

export async function deleteTenant(id: string): Promise<void> {
  const res = await signedFetch('DELETE', `/internal/tenants/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`api: deleteTenant failed (${res.status})`);
}

export type LeaderboardWindow = 'all' | 'month';

export async function topScores(params: {
  tenant: string;
  window?: LeaderboardWindow;
  limit?: number;
}): Promise<ScoreEntry[]> {
  const limit = params.limit ?? DEFAULT_TOP_LIMIT;
  const base = `/internal/leaderboard/${encodeURIComponent(params.tenant)}?limit=${limit}`;
  const path = params.window === 'month' ? `${base}&window=month` : base;
  const res = await signedFetch('GET', path);
  if (!res.ok) throw new Error(`api: topScores failed (${res.status})`);
  return (await res.json()) as ScoreEntry[];
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array)) return new Uint8Array(input);
  if (input.buffer instanceof ArrayBuffer) return input as Uint8Array<ArrayBuffer>;
  return new Uint8Array(input);
}

export async function uploadAsset(params: {
  key: string;
  contentType: string;
  bytes: ArrayBuffer | Uint8Array;
}): Promise<{ url: string }> {
  const body = toBytes(params.bytes);
  const path = `/internal/uploads?key=${encodeURIComponent(params.key)}&content_type=${encodeURIComponent(params.contentType)}`;
  const res = await signedSend({ method: 'POST', path, body, contentType: params.contentType });
  if (!res.ok) throw new Error(`api: uploadAsset failed (${res.status})`);
  return (await res.json()) as { url: string };
}
