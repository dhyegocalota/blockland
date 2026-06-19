// Server-side client for the Rust internal data API. Signs every request with the
// HMAC channel contract (METHOD\nPATH\nTS\nNONCE\nSHA256_HEX(BODY)) and proxies to
// the Rust server; the browser never talks to the database directly.
import 'server-only';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Tenant } from './builtins';

const DEFAULT_RUST_API_URL = 'http://localhost:8080';
const NONCE_BYTES = 16;
const DEFAULT_TOP_LIMIT = 10;

export interface ScoreEntry {
  name: string;
  score: number;
}

function secret(): string {
  const value = process.env.INTERNAL_HMAC_SECRET;
  if (!value) throw new Error('rust-api: INTERNAL_HMAC_SECRET is not set');
  return value;
}

function baseUrl(): string {
  return process.env.RUST_API_URL || DEFAULT_RUST_API_URL;
}

export function sign(params: {
  method: string;
  path: string;
  ts: string;
  nonce: string;
  body: string;
}): string {
  const bodyHash = createHash('sha256').update(params.body, 'utf8').digest('hex');
  const canonical = [params.method, params.path, params.ts, params.nonce, bodyHash].join('\n');
  return createHmac('sha256', secret()).update(canonical, 'utf8').digest('hex');
}

export async function signedFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const hasBody = body !== undefined;
  const rawBody = hasBody ? JSON.stringify(body) : '';
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const signature = sign({ method, path, ts, nonce, body: rawBody });

  const headers: Record<string, string> = {
    'x-bl-ts': ts,
    'x-bl-nonce': nonce,
    'x-bl-sig': signature,
  };
  if (hasBody) headers['content-type'] = 'application/json';

  return fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: hasBody ? rawBody : undefined,
    cache: 'no-store',
  });
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const res = await signedFetch('GET', `/internal/tenants/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`rust-api: getTenant failed (${res.status})`);
  return (await res.json()) as Tenant;
}

export async function listTenants(): Promise<Tenant[]> {
  const res = await signedFetch('GET', '/internal/tenants');
  if (!res.ok) throw new Error(`rust-api: listTenants failed (${res.status})`);
  return (await res.json()) as Tenant[];
}

export async function upsertTenant(tenant: Tenant): Promise<Tenant> {
  const res = await signedFetch('POST', '/internal/tenants', tenant);
  if (!res.ok) throw new Error(`rust-api: upsertTenant failed (${res.status})`);
  return (await res.json()) as Tenant;
}

export async function deleteTenant(id: string): Promise<void> {
  const res = await signedFetch('DELETE', `/internal/tenants/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`rust-api: deleteTenant failed (${res.status})`);
}

export async function topScores(tenant: string, limit: number = DEFAULT_TOP_LIMIT): Promise<ScoreEntry[]> {
  const path = `/internal/leaderboard/${encodeURIComponent(tenant)}?limit=${limit}`;
  const res = await signedFetch('GET', path);
  if (!res.ok) throw new Error(`rust-api: topScores failed (${res.status})`);
  return (await res.json()) as ScoreEntry[];
}
