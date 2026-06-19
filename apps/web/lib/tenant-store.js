// Tenant store backed by libSQL. Local file in dev (`file:.data/blocklandia.db`),
// a Turso/libSQL URL in production via DATABASE_URL (+ DATABASE_AUTH_TOKEN).
import 'server-only';
import fs from 'node:fs';
import { createClient } from '@libsql/client/node';
import { BUILTIN_TENANTS } from './builtins';

let client;
let ready;

function db() {
  if (client) return client;
  const url = process.env.DATABASE_URL || 'file:.data/blocklandia.db';
  if (url.startsWith('file:')) {
    try { fs.mkdirSync('.data', { recursive: true }); } catch { /* exists */ }
  }
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  client = createClient(authToken ? { url, authToken } : { url });
  return client;
}

async function ensure() {
  if (ready) return ready;
  ready = (async () => {
    await db().execute(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hero TEXT NOT NULL,
        title_a TEXT NOT NULL,
        title_b TEXT NOT NULL,
        tagline TEXT NOT NULL,
        primary_color TEXT NOT NULL,
        avatar TEXT NOT NULL,
        face_texture TEXT NOT NULL,
        face_block_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
    const count = await db().execute('SELECT COUNT(*) AS n FROM tenants');
    if (Number(count.rows[0].n) === 0) {
      for (const t of Object.values(BUILTIN_TENANTS)) await insertRow(t);
    }
  })();
  return ready;
}

// Raw upsert without `ensure()` — used by both the seed and the public API to avoid
// re-entering `ensure()` (which would deadlock during seeding).
async function insertRow(t) {
  await db().execute({
    sql: `INSERT INTO tenants
      (id, name, hero, title_a, title_b, tagline, primary_color, avatar, face_texture, face_block_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, hero=excluded.hero, title_a=excluded.title_a, title_b=excluded.title_b,
        tagline=excluded.tagline, primary_color=excluded.primary_color, avatar=excluded.avatar,
        face_texture=excluded.face_texture, face_block_name=excluded.face_block_name`,
    args: [
      t.id, t.name, t.hero, t.titleA, t.titleB, t.tagline,
      t.primary, t.avatar, t.faceTexture, t.faceBlockName, Date.now(),
    ],
  });
}

function rowToTenant(r) {
  return {
    id: r.id,
    name: r.name,
    hero: r.hero,
    titleA: r.title_a,
    titleB: r.title_b,
    tagline: r.tagline,
    primary: r.primary_color,
    avatar: r.avatar,
    faceTexture: r.face_texture,
    faceBlockName: r.face_block_name,
  };
}

export async function listTenants() {
  await ensure();
  const res = await db().execute('SELECT * FROM tenants ORDER BY created_at ASC');
  return res.rows.map(rowToTenant);
}

export async function getTenant(id) {
  await ensure();
  const res = await db().execute({ sql: 'SELECT * FROM tenants WHERE id = ?', args: [id] });
  if (res.rows.length === 0) return null;
  return rowToTenant(res.rows[0]);
}

export async function upsertTenant(t) {
  await ensure();
  await insertRow(t);
  return getTenant(t.id);
}

export async function deleteTenant(id) {
  await ensure();
  await db().execute({ sql: 'DELETE FROM tenants WHERE id = ?', args: [id] });
}
