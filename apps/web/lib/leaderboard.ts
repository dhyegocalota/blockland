// Per-tenant leaderboard backed by libSQL. Local file in dev (`file:.data/blocklandia.db`),
// a Turso/libSQL URL in production via DATABASE_URL (+ DATABASE_AUTH_TOKEN).
import 'server-only';
import fs from 'node:fs';
import { createClient, type Client } from '@libsql/client/node';

const NAME_MAX_LENGTH = 16;
const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 100;

let client: Client | undefined;
let ready: Promise<void> | undefined;

function db(): Client {
  if (client) return client;
  const url = process.env.DATABASE_URL || 'file:.data/blocklandia.db';
  if (url.startsWith('file:')) {
    try { fs.mkdirSync('.data', { recursive: true }); } catch { /* exists */ }
  }
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  client = createClient(authToken ? { url, authToken } : { url });
  return client;
}

async function ensure(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db().execute(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        tenant TEXT NOT NULL,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, name)
      )`);
  })();
  return ready;
}

// Raw upsert without `ensure()` — keeps the insert separate from `ensure()` to avoid the
// re-entrancy deadlock that the tenant store hit during seeding.
async function insertRow(params: { tenant: string; name: string; score: number }): Promise<void> {
  await db().execute({
    sql: `INSERT INTO leaderboard (tenant, name, score, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant, name) DO UPDATE SET
        score = MAX(leaderboard.score, excluded.score),
        created_at = excluded.created_at`,
    args: [params.tenant, params.name, params.score, Date.now()],
  });
}

export type ScoreEntry = { name: string; score: number };

function sanitizeName(name: string): string {
  return name.trim().slice(0, NAME_MAX_LENGTH);
}

function isValidScore(score: number): boolean {
  return Number.isInteger(score) && Number.isFinite(score) && score >= 0;
}

export async function submitScore(params: { tenant: string; name: string; score: number }): Promise<void> {
  const tenant = params.tenant.trim();
  if (tenant === '') throw new Error('leaderboard: tenant is required');
  const name = sanitizeName(params.name);
  if (name === '') throw new Error('leaderboard: name is required');
  if (!isValidScore(params.score)) throw new Error('leaderboard: score must be a non-negative integer');

  await ensure();
  await insertRow({ tenant, name, score: params.score });
}

export async function topScores(tenant: string, limit: number = DEFAULT_TOP_LIMIT): Promise<ScoreEntry[]> {
  const clampedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_TOP_LIMIT);
  await ensure();
  const res = await db().execute({
    sql: 'SELECT name, score FROM leaderboard WHERE tenant = ? ORDER BY score DESC, created_at ASC LIMIT ?',
    args: [tenant.trim(), clampedLimit],
  });
  return res.rows.map((r) => ({ name: String(r.name), score: Number(r.score) }));
}
