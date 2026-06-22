# 🧱 Blockland

A **white-label** platform of 3D block worlds for kids: build, hunt creatures, fight
monsters, collect stars and fly. Each customer is a **tenant** with its own branding
(name, colors, avatar, photo-on-a-block). The sample tenant shipped with the repo is
**Acme**.

The interface defaults to **pt-BR** (en-US is also available) through an i18n layer,
while each tenant's content (name, tagline, titles, hero) is stored as data.

## Monorepo

```
apps/
  web/                  Next.js 14 (App Router) game client (single-player) — hosted on Vercel
    app/                routes: game page, /admin panel, /api routes
    lib/
      game-engine.js    game engine (voxels, physics, creatures, builds) — brand-driven
      tenants.js        client-side tenant resolution (?tenant= or subdomain)
      tenant-store.js   tenant persistence backed by libSQL
      builtins.js       built-in tenants (seed + offline fallback)
      i18n/             message catalog and runtime (pt-BR default, en-US available)
    public/             per-tenant assets (e.g. /tenants/acme/face.png)
    test/               test stubs/helpers
  server/               authoritative multiplayer server (Rust workspace)
    crates/
      protocol/         wire types (client <-> server)
      sim/              shareable worldgen/voxel/collision (future client WASM)
      server/           tokio + axum: rooms, 20Hz tick, anti-cheat, observability
    tenants.toml        tenants and per-tenant quotas
    tools/test-client   load/smoke bots (Node, no deps)
    Dockerfile          server build
docker-compose.yml      local server with CPU/RAM limits
```

## Web client

```bash
cd apps/web
npm install
npm run dev     # http://localhost:3000
```

- Pick a tenant with `/?tenant=acme` (or a subdomain). Another tenant: `/?tenant=demo`.
- To add a new customer, create a tenant from the `/admin` panel (or add it to
  `apps/web/lib/builtins.js` to ship it as a built-in) — nothing tenant-specific is baked
  into the engine.

### Tenant resolution

The active tenant is resolved client-side (`apps/web/lib/tenants.js`):

1. `?tenant=<id>` query parameter wins (e.g. `/?tenant=demo`).
2. Otherwise the first subdomain label is used (e.g. `acme.localhost` → `acme`).
   `www` and bare `localhost`/`*.vercel.app` hosts are not treated as tenant subdomains.
3. Otherwise no tenant resolves and the client surfaces the failure (no silent default).

The resolved id is fetched from the tenant store via `/api/tenants/<id>`; if the store is
unreachable it falls back to the built-in tenants.

### Local subdomain tenant access

```
http://acme.localhost:3000     # Acme
http://demo.localhost:3000     # Demo World
```

Most browsers resolve `*.localhost` to the loopback address automatically, so no `hosts`
file changes are needed. If your environment does not, add the subdomains to
`/etc/hosts` pointing at `127.0.0.1`.

### /admin panel

`http://localhost:3000/admin` manages tenants (create, edit, delete). Log in with the
value of `ADMIN_KEY` — the same key is sent on every request as the `x-admin-key` header
(see `apps/web/lib/admin-auth.js`). The admin API lives under `/api/admin/tenants`.

### Tenant store

Tenant content is persisted with libSQL (`apps/web/lib/tenant-store.js`):

- Development: a local file at `apps/web/.data/blockland.db` (used when `DATABASE_URL`
  is unset).
- Production: a Turso/libSQL URL via `DATABASE_URL` (+ `DATABASE_AUTH_TOKEN`).

The table is created and seeded from the built-in tenants on first run.

## Multiplayer server (Rust) — local with Docker

```bash
docker compose up --build game-server
node apps/server/tools/test-client.mjs 4 acme lobby                             # connect 4 bots and print the verdict
curl -H "x-admin-token: dev-admin-secret" http://localhost:8080/admin/stats    # who is online, where, ping
```

Highlights: the server is the **source of truth** (20 Hz tick, validates speed/reach,
rejects teleports), **≤10 players/room**, rooms isolated by `(tenant, world)`, abuse
controls (per-player token bucket, per-IP limit, idle timeout) and observability
(`/admin/stats`, `/healthz`, logs). Tenants and quotas live in `tenants.toml`.

Endpoints (`apps/server/crates/server/src/main.rs`):

- `GET /healthz` — liveness probe.
- `GET /admin/stats` — online players, rooms and ping (requires the `x-admin-token` header).
- `GET /ws` — gameplay WebSocket.

> The client netcode (prediction + interpolation) and the `sim` WASM port are the next
> phases — the server is already implemented and tested.

## Environment variables

See `.env.sample` for the full list with comments.

**Web (`apps/web`):**

| Variable | Purpose |
| --- | --- |
| `ADMIN_KEY` | Secret for the `/admin` panel and `/api/admin/*` routes. |
| `DATABASE_URL` | libSQL/Turso URL for the tenant store. Unset → local SQLite file. |
| `DATABASE_AUTH_TOKEN` | Auth token for a remote libSQL/Turso database. |

**Server (`apps/server`):**

| Variable | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Secret for `GET /admin/stats` (sent as the `x-admin-token` header). |
| `BIND` | Address the server binds to (default `0.0.0.0:8080`). |
| `RUST_LOG` | Log filter (e.g. `info,server=debug`). |
| `TENANTS_FILE` | Path to a `tenants.toml` override (default uses the bundled file). |

## Tests

**Server (Rust):**

```bash
cd apps/server
cargo test
```

Unit tests live in `crates/sim` and `crates/server` (anti-cheat, rooms, worldgen).
The `tools/test-client.mjs` bots provide an end-to-end smoke check against a running
server (it walks bots under the speed cap and asserts the anti-cheat rejects a teleport).

## CI

No CI workflow is configured yet. The recommended pipeline runs `cargo test` for the
server workspace and `npm run build` for the web client on every push.

---

Made with 💛 — it started as a Minecraft for one kid and became a platform.
