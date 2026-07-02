//! The database lives here: a local libSQL file owned by this server. Next no longer talks
//! to libSQL directly; it proxies through the HMAC-signed internal API backed by this module.
//! `DATABASE_PATH` (default `./data/blockland.db`) points at the file; later a Turso URL +
//! token would swap into `Builder::new_remote` without changing any call site.

use libsql::{params, Builder, Connection, Database};
use rand::Rng;
use serde::{Deserialize, Serialize};

const DEFAULT_DATABASE_PATH: &str = "./data/blockland.db";
const DEFAULT_TOP_LIMIT: u32 = 10;
const MAX_TOP_LIMIT: u32 = 100;
const ACCOUNT_ID_HEX_CHARS: usize = 24;
const DEFAULT_EVENT_BACKLOG: u32 = 20;
const MAX_EVENT_BACKLOG: u32 = 100;
const DEFAULT_CHAT_BACKLOG: u32 = 200;
const MAX_CHAT_BACKLOG: u32 = 200;
const DEFAULT_REPORT_ROWS: u32 = 200;
const MAX_REPORT_ROWS: u32 = 500;
/// Persisted chat is never kept beyond this window (mirrored in the public Privacy Policy).
pub const CHAT_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// White-label branding + per-tenant limits for one tenant: a subdomain id, a display name, one
/// image URL (lobby avatar + in-game face-block texture), the play-time budget (minutes within a
/// rolling window of hours; 0 = unlimited) and which game modes are allowed. The lobby fetches this
/// over HTTP before joining so it can gate the mode buttons. Mirrors the web `Tenant`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: String,
    pub name: String,
    pub image: String,
    // The limit fields default on deserialize so the /admin upsert (which posts only id/name/image)
    // still parses; `insert_tenant` never writes them, so the db column defaults stay authoritative.
    #[serde(default)]
    pub playtime_limit_min: u32,
    #[serde(default)]
    pub playtime_window_h: u32,
    #[serde(default = "mode_default")]
    pub online_allowed: bool,
    #[serde(default = "mode_default")]
    pub offline_allowed: bool,
}

fn mode_default() -> bool {
    true
}

/// One leaderboard row in the public top-scores view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreEntry {
    pub name: String,
    pub score: i64,
}

pub use game_core::Role;

/// An account is identified by a stable `account_id`; the `name` is its current, MUTABLE display
/// name within a tenant. Identity is per tenant: `(tenant, email)` and `(tenant, name)` are unique.
/// `is_admin`/`is_moderator` back the `Role` capability tier (see `Role`).
#[derive(Debug, Clone)]
pub struct Account {
    pub account_id: String,
    pub tenant: String,
    pub name: String,
    pub email: String,
    pub is_admin: bool,
    pub is_moderator: bool,
}

impl Account {
    pub fn role(&self) -> Role {
        Role::from_flags(self.is_admin, self.is_moderator)
    }
}

/// One account row in the /admin panel's per-tenant account list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub account_id: String,
    pub name: String,
    pub email: String,
    pub is_admin: bool,
    pub is_moderator: bool,
}

/// Result of finding-or-creating an account for `(tenant, email)`: the stable id, its current name,
/// and whether the requested name took effect (a free name renames; a taken name keeps the current).
#[derive(Debug, Clone)]
pub struct ClaimedAccount {
    pub account_id: String,
    pub name: String,
    pub renamed: bool,
    pub old_name: String,
    pub is_admin: bool,
    pub is_moderator: bool,
}

impl ClaimedAccount {
    pub fn role(&self) -> Role {
        Role::from_flags(self.is_admin, self.is_moderator)
    }
}

/// A pending login: a clicked-link `token` and a typed `code` both unlock the same (tenant, name, email).
#[derive(Debug, Clone)]
pub struct MagicLink {
    pub tenant: String,
    pub name: String,
    pub email: String,
}

/// One persisted timeline event echoed in-game (e.g. a rename: `name` = new name, `detail` = old name).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEvent {
    pub kind: String,
    pub name: String,
    pub detail: String,
}

/// One persisted chat line for the admin chat-log report: who said it, the text, and when (ms epoch).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEntry {
    pub name: String,
    pub text: String,
    pub sent_at: i64,
}

/// One row of the hours-played report: a player key (account id, or `ip:<addr>` for a guest) and the
/// milliseconds it has accrued in the tenant's current window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaytimeEntry {
    pub key: String,
    pub used_ms: i64,
}

/// One account waiting for an admin to let it into a tenant whose approval gate is on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingApproval {
    pub account_id: String,
    pub name: String,
    pub email: String,
}

/// Owns the libSQL handle. `conn()` hands out the connection each operation runs on:
/// - **Remote** libSQL (Turso / `turso dev`): a fresh connection PER OP (`shared` is `None`). A
///   long-lived remote connection's Hrana stream expires on inactivity (`STREAM_EXPIRED`), which would
///   break the room-lease queries; a per-op connection always runs on a live stream and reads/writes
///   the one shared db directly, so the lease stays strongly consistent across instances.
/// - **Local** file / `:memory:`: ONE shared connection (`shared` is `Some`) — a local connection has
///   no stream to expire, and a fresh `:memory:` connection would be a SEPARATE empty db, so the single
///   connection IS the store. `Connection` is `Arc`-backed (cheap to clone).
pub struct Db {
    database: Database,
    shared: Option<Connection>,
}

impl Db {
    fn conn(&self) -> Result<Connection, libsql::Error> {
        match &self.shared {
            Some(conn) => Ok(conn.clone()),
            None => self.database.connect(),
        }
    }
}

impl Db {
    /// Open the db (remote libSQL when `DATABASE_URL` is set, else a local file), create the schema,
    /// and seed the built-in tenants if empty.
    pub async fn open() -> Result<Self, libsql::Error> {
        let db = match std::env::var("DATABASE_URL") {
            // Remote libSQL — a Turso cloud db OR a local `turso dev` / `sqld` server. It is concurrent
            // with no file lock, so MANY server instances can share ONE db (the room-lease coordination
            // point that lets them run behind a load balancer). This is the multi-server backing.
            // `DATABASE_AUTH_TOKEN` is empty for a no-auth local dev server. No shared connection — a
            // fresh one per op (see the struct doc).
            Ok(url) if !url.trim().is_empty() => {
                let token = std::env::var("DATABASE_AUTH_TOKEN").unwrap_or_default();
                tracing::info!(%url, "opening remote libSQL (shared db, multi-server)");
                let database = Builder::new_remote(url, token).build().await?;
                Self {
                    database,
                    shared: None,
                }
            }
            // A single local SQLite file — one instance only (SQLite is single-writer, so two processes
            // opening one file race on init / lock; use DATABASE_URL above to run more than one instance).
            _ => {
                let path = std::env::var("DATABASE_PATH")
                    .unwrap_or_else(|_| DEFAULT_DATABASE_PATH.to_string());
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let database = Builder::new_local(&path).build().await?;
                let shared = Some(database.connect()?);
                Self { database, shared }
            }
        };
        db.ensure().await?;
        Ok(db)
    }

    /// An ephemeral in-memory db with the schema applied; used by tests across the crate.
    #[cfg(test)]
    pub(crate) async fn memory() -> Self {
        let database = Builder::new_local(":memory:").build().await.unwrap();
        let shared = Some(database.connect().unwrap());
        let db = Self { database, shared };
        db.ensure().await.unwrap();
        db
    }

    async fn ensure(&self) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS tenants (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    image TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY,
                    tenant TEXT NOT NULL,
                    email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    is_moderator INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    UNIQUE (tenant, email),
                    UNIQUE (tenant, name)
                )",
                (),
            )
            .await?;
        // Backfill columns on databases created before they existed; ignore the error if a column is
        // already there (libSQL has no `ADD COLUMN IF NOT EXISTS`).
        for column in [
            "ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE accounts ADD COLUMN is_moderator INTEGER NOT NULL DEFAULT 0",
            // Per-tenant play-time budget: 0 = unlimited (the default for normal worlds).
            "ALTER TABLE tenants ADD COLUMN playtime_limit_min INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE tenants ADD COLUMN playtime_window_h INTEGER NOT NULL DEFAULT 0",
            // Per-tenant moderation flags an admin toggles at runtime (both off by default).
            "ALTER TABLE tenants ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE tenants ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0",
            // Which game modes a tenant allows (both on by default); an admin can block either, but
            // never the last one (enforced where the toggle is applied).
            "ALTER TABLE tenants ADD COLUMN online_allowed INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE tenants ADD COLUMN offline_allowed INTEGER NOT NULL DEFAULT 1",
            // Whether monsters are calm (peace) — persisted so the admin's choice survives a room
            // restart. Default 1 (calm) keeps new worlds kid-safe until an admin turns monsters on.
            "ALTER TABLE tenants ADD COLUMN peace INTEGER NOT NULL DEFAULT 1",
            // Runtime admin toggles that must survive a room/server restart, like peace above: player-vs-
            // player (default off), the room chat (default on), and the comma-joined set of prebuilt
            // structure kinds an admin has blocked from the build menu (default none blocked).
            "ALTER TABLE tenants ADD COLUMN pvp INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE tenants ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE tenants ADD COLUMN blocked_structures TEXT NOT NULL DEFAULT ''",
            // The slim branding model: one image replaces the old avatar/face_texture split. On a
            // legacy-wide db this adds the column and the backfill below seeds it from `avatar`.
            "ALTER TABLE tenants ADD COLUMN image TEXT NOT NULL DEFAULT ''",
            // A held player an admin rejected: the row stays (so the next join is told "rejected")
            // until an admin approves them, which clears it.
            "ALTER TABLE approval_requests ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0",
        ] {
            let _ = self.conn()?.execute(column, ()).await;
        }
        // Backfill `image` from the legacy `avatar` column where it exists and image is still blank.
        // The whole statement is ignored on a slim db that never had an `avatar` column.
        let _ = self
            .conn()?
            .execute(
                "UPDATE tenants SET image = avatar WHERE image = '' AND avatar IS NOT NULL",
                (),
            )
            .await;
        // Drop the dead legacy-wide branding columns now that `image` is backfilled. They are NOT NULL
        // with no default, so leaving them in place makes every new tenant upsert (which only writes
        // id/name/image) fail with a NOT NULL violation. Ignored on a slim db that never had them.
        for column in [
            "ALTER TABLE tenants DROP COLUMN hero",
            "ALTER TABLE tenants DROP COLUMN title_a",
            "ALTER TABLE tenants DROP COLUMN title_b",
            "ALTER TABLE tenants DROP COLUMN tagline",
            "ALTER TABLE tenants DROP COLUMN primary_color",
            "ALTER TABLE tenants DROP COLUMN avatar",
            "ALTER TABLE tenants DROP COLUMN face_texture",
            "ALTER TABLE tenants DROP COLUMN face_block_name",
        ] {
            let _ = self.conn()?.execute(column, ()).await;
        }
        // Per-account play time used inside the current rolling window (for the play-time limit).
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS playtime (
                    tenant TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    window_start_ms INTEGER NOT NULL,
                    used_ms INTEGER NOT NULL,
                    PRIMARY KEY (tenant, account_id)
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS bans (
                    ip TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS worlds (
                    tenant TEXT PRIMARY KEY,
                    blob BLOB NOT NULL,
                    updated_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        // The cross-instance room lease: one row per served room (tenant, world), naming the server
        // instance that owns it and when it last beat. The shared db is the only coordination point,
        // so two instances behind a load balancer can never serve the same room at once.
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS room_leases (
                    tenant TEXT NOT NULL,
                    world TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    heartbeat_ms INTEGER NOT NULL,
                    PRIMARY KEY (tenant, world)
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS leaderboard (
                    tenant TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    score INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (tenant, account_id)
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS magic_links (
                    token TEXT PRIMARY KEY,
                    code TEXT NOT NULL,
                    tenant TEXT NOT NULL,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                // One row per signed-in device (keyed by token), so an account can hold several live
                // claims at once — logging in on a new device never evicts the others.
                "CREATE TABLE IF NOT EXISTS device_claims (
                    token TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    tenant TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        // Every accepted chat line, kept for the admin chat-log report within the retention window.
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS chat_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant TEXT NOT NULL,
                    name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    sent_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        // An approved account (allowed in while the tenant's approval gate is on) is a row here.
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS approvals (
                    tenant TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    approved_at INTEGER NOT NULL,
                    PRIMARY KEY (tenant, account_id)
                )",
                (),
            )
            .await?;
        // A not-yet-approved account that tried to join while the gate was on, awaiting an admin.
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS approval_requests (
                    tenant TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    requested_at INTEGER NOT NULL,
                    rejected INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (tenant, account_id)
                )",
                (),
            )
            .await?;
        self.conn()?
            .execute(
                "CREATE TABLE IF NOT EXISTS waitlist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE,
                    name TEXT,
                    phone TEXT,
                    created_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;

        let mut rows = self
            .conn()?
            .query("SELECT COUNT(*) AS n FROM tenants", ())
            .await?;
        let count = match rows.next().await? {
            Some(row) => row.get::<i64>(0)?,
            None => 0,
        };
        if count == 0 {
            for tenant in builtin_tenants() {
                self.insert_tenant(&tenant).await?;
            }
            // The demo world is a 5-minutes-per-24h taste; real tenants stay unlimited.
            self.conn()?
                .execute(
                    "UPDATE tenants SET playtime_limit_min = 5, playtime_window_h = 24 WHERE id = 'demo'",
                    (),
                )
                .await?;
        }
        Ok(())
    }

    /// A tenant's play-time budget: (minutes allowed, window hours). Both 0 means unlimited.
    pub async fn tenant_playtime(&self, tenant: &str) -> Result<(i64, i64), libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT playtime_limit_min, playtime_window_h FROM tenants WHERE id = ?1",
                params![tenant],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok((row.get::<i64>(0)?, row.get::<i64>(1)?)),
            None => Ok((0, 0)),
        }
    }

    /// A tenant's runtime moderation flags: (suspended, approval_required). Both off for a fresh tenant.
    pub async fn tenant_flags(&self, tenant: &str) -> Result<(bool, bool), libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT suspended, approval_required FROM tenants WHERE id = ?1",
                params![tenant],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok((row.get::<i64>(0)? != 0, row.get::<i64>(1)? != 0)),
            None => Ok((false, false)),
        }
    }

    pub async fn set_tenant_suspended(&self, tenant: &str, on: bool) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET suspended = ?2 WHERE id = ?1",
                params![tenant, on as i64],
            )
            .await?;
        Ok(())
    }

    pub async fn set_tenant_approval_required(
        &self,
        tenant: &str,
        on: bool,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET approval_required = ?2 WHERE id = ?1",
                params![tenant, on as i64],
            )
            .await?;
        Ok(())
    }

    /// Persist a tenant's play-time budget (minutes within a rolling window of hours; 0 = unlimited).
    pub async fn set_tenant_playtime(
        &self,
        tenant: &str,
        limit_min: u32,
        window_h: u32,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET playtime_limit_min = ?2, playtime_window_h = ?3 WHERE id = ?1",
                params![tenant, limit_min as i64, window_h as i64],
            )
            .await?;
        Ok(())
    }

    /// A tenant's allowed game modes: (online_allowed, offline_allowed). Both on for a fresh tenant.
    pub async fn tenant_modes(&self, tenant: &str) -> Result<(bool, bool), libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT online_allowed, offline_allowed FROM tenants WHERE id = ?1",
                params![tenant],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok((row.get::<i64>(0)? != 0, row.get::<i64>(1)? != 0)),
            None => Ok((true, true)),
        }
    }

    /// Persist a tenant's allowed game modes. The caller must guarantee at least one stays on.
    pub async fn set_tenant_modes(
        &self,
        tenant: &str,
        online_allowed: bool,
        offline_allowed: bool,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET online_allowed = ?2, offline_allowed = ?3 WHERE id = ?1",
                params![tenant, online_allowed as i64, offline_allowed as i64],
            )
            .await?;
        Ok(())
    }

    /// Whether monsters are calm for a tenant (default true = calm for a fresh world).
    pub async fn tenant_peace(&self, tenant: &str) -> Result<bool, libsql::Error> {
        let mut rows = self
            .conn()?
            .query("SELECT peace FROM tenants WHERE id = ?1", params![tenant])
            .await?;
        match rows.next().await? {
            Some(row) => Ok(row.get::<i64>(0)? != 0),
            None => Ok(true),
        }
    }

    /// Persist whether monsters are calm, so the admin's peace toggle survives a room restart.
    pub async fn set_tenant_peace(&self, tenant: &str, peace: bool) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET peace = ?2 WHERE id = ?1",
                params![tenant, peace as i64],
            )
            .await?;
        Ok(())
    }

    /// Whether player-vs-player combat is on for a tenant (default false = off for a fresh world).
    pub async fn tenant_pvp(&self, tenant: &str) -> Result<bool, libsql::Error> {
        let mut rows = self
            .conn()?
            .query("SELECT pvp FROM tenants WHERE id = ?1", params![tenant])
            .await?;
        match rows.next().await? {
            Some(row) => Ok(row.get::<i64>(0)? != 0),
            None => Ok(false),
        }
    }

    /// Persist the pvp toggle, so the admin's choice survives a room restart.
    pub async fn set_tenant_pvp(&self, tenant: &str, pvp: bool) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET pvp = ?2 WHERE id = ?1",
                params![tenant, pvp as i64],
            )
            .await?;
        Ok(())
    }

    /// Whether the room chat is on for a tenant (default true = on for a fresh world).
    pub async fn tenant_chat_enabled(&self, tenant: &str) -> Result<bool, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT chat_enabled FROM tenants WHERE id = ?1",
                params![tenant],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(row.get::<i64>(0)? != 0),
            None => Ok(true),
        }
    }

    /// Persist the chat toggle, so the admin's choice survives a room restart.
    pub async fn set_tenant_chat(&self, tenant: &str, on: bool) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET chat_enabled = ?2 WHERE id = ?1",
                params![tenant, on as i64],
            )
            .await?;
        Ok(())
    }

    /// The structure kinds an admin has blocked from the build menu (empty for a fresh world). Stored
    /// comma-joined; the kinds are identifiers with no commas, so the split round-trips exactly.
    pub async fn tenant_blocked_structures(
        &self,
        tenant: &str,
    ) -> Result<Vec<String>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT blocked_structures FROM tenants WHERE id = ?1",
                params![tenant],
            )
            .await?;
        let joined = match rows.next().await? {
            Some(row) => row.get::<String>(0)?,
            None => String::new(),
        };
        Ok(joined
            .split(',')
            .filter(|kind| !kind.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// Persist the blocked-structure set, so the admin's build-menu choices survive a room restart.
    pub async fn set_tenant_blocked_structures(
        &self,
        tenant: &str,
        kinds: &[String],
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE tenants SET blocked_structures = ?2 WHERE id = ?1",
                params![tenant, kinds.join(",")],
            )
            .await?;
        Ok(())
    }

    /// A tenant's persisted world blob (the compressed edit diff), if it has one.
    pub async fn load_world(&self, tenant: &str) -> Result<Option<Vec<u8>>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query("SELECT blob FROM worlds WHERE tenant = ?1", params![tenant])
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(row.get::<Vec<u8>>(0)?)),
            None => Ok(None),
        }
    }

    /// Write a tenant's world blob (replacing any previous one).
    pub async fn save_world(&self, tenant: &str, blob: &[u8]) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO worlds (tenant, blob, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(tenant) DO UPDATE SET blob = ?2, updated_at = ?3",
                params![tenant, blob.to_vec(), now_ms()],
            )
            .await?;
        Ok(())
    }

    /// Take (or keep) the lease on a room for `owner`. The upsert wins only when the row is unheld,
    /// already ours, or stale (its last heartbeat is older than `stale_ms`); otherwise a live other
    /// owner's row is left untouched. The threshold is computed in Rust and bound, then a follow-up
    /// SELECT confirms who holds the row — we own it iff that owner is us.
    pub async fn acquire_room_lease(
        &self,
        tenant: &str,
        world: &str,
        owner: &str,
        now_ms: i64,
        stale_ms: i64,
    ) -> Result<bool, libsql::Error> {
        let stale_before = now_ms - stale_ms;
        self.conn()?
            .execute(
                "INSERT INTO room_leases (tenant, world, owner, heartbeat_ms) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(tenant, world) DO UPDATE SET owner = excluded.owner, heartbeat_ms = excluded.heartbeat_ms
                 WHERE room_leases.owner = excluded.owner OR room_leases.heartbeat_ms < ?5",
                params![tenant, world, owner, now_ms, stale_before],
            )
            .await?;
        let mut rows = self
            .conn()?
            .query(
                "SELECT owner FROM room_leases WHERE tenant = ?1 AND world = ?2",
                params![tenant, world],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(row.get::<String>(0)? == owner),
            None => Ok(false),
        }
    }

    /// Refresh our lease heartbeat. A no-op if the row is no longer ours (another owner took over).
    pub async fn renew_room_lease(
        &self,
        tenant: &str,
        world: &str,
        owner: &str,
        now_ms: i64,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE room_leases SET heartbeat_ms = ?4 WHERE tenant = ?1 AND world = ?2 AND owner = ?3",
                params![tenant, world, owner, now_ms],
            )
            .await?;
        Ok(())
    }

    /// Drop our lease on room close, only when the row is still ours (never steal another owner's row).
    pub async fn release_room_lease(
        &self,
        tenant: &str,
        world: &str,
        owner: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "DELETE FROM room_leases WHERE tenant = ?1 AND world = ?2 AND owner = ?3",
                params![tenant, world, owner],
            )
            .await?;
        Ok(())
    }

    /// Every banned IP as a string, to warm the in-memory ban set on startup.
    pub async fn all_bans(&self) -> Result<Vec<String>, libsql::Error> {
        let mut rows = self.conn()?.query("SELECT ip FROM bans", ()).await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get::<String>(0)?);
        }
        Ok(out)
    }

    pub async fn add_ban(&self, ip: &str) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO bans (ip, created_at) VALUES (?1, ?2) ON CONFLICT(ip) DO NOTHING",
                params![ip, now_ms()],
            )
            .await?;
        Ok(())
    }

    pub async fn remove_ban(&self, ip: &str) -> Result<(), libsql::Error> {
        self.conn()?
            .execute("DELETE FROM bans WHERE ip = ?1", params![ip])
            .await?;
        Ok(())
    }

    /// Drop bans older than the retention window so a banned IP is never kept indefinitely. Returns the
    /// number of rows removed.
    pub async fn purge_stale_bans(&self, max_age_ms: i64) -> Result<u64, libsql::Error> {
        let cutoff = now_ms() - max_age_ms;
        self.conn()?
            .execute("DELETE FROM bans WHERE created_at < ?1", params![cutoff])
            .await
    }

    /// Insert a ban with an explicit timestamp, to exercise the retention purge.
    #[cfg(test)]
    pub(crate) async fn add_ban_at(&self, ip: &str, created_at: i64) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO bans (ip, created_at) VALUES (?1, ?2)
                 ON CONFLICT(ip) DO UPDATE SET created_at = excluded.created_at",
                params![ip, created_at],
            )
            .await?;
        Ok(())
    }

    /// Drop timeline/moderation events older than the retention window. Returns the rows removed.
    pub async fn purge_stale_events(&self, max_age_ms: i64) -> Result<u64, libsql::Error> {
        let cutoff = now_ms() - max_age_ms;
        self.conn()?
            .execute("DELETE FROM events WHERE created_at < ?1", params![cutoff])
            .await
    }

    /// Drop play-time accounting rows whose window started before the retention cutoff. Returns the
    /// rows removed.
    pub async fn purge_stale_playtime(&self, max_age_ms: i64) -> Result<u64, libsql::Error> {
        let cutoff = now_ms() - max_age_ms;
        self.conn()?
            .execute(
                "DELETE FROM playtime WHERE window_start_ms < ?1",
                params![cutoff],
            )
            .await
    }

    /// Drop chat lines older than the retention window. Returns the rows removed.
    pub async fn purge_stale_chat(&self, max_age_ms: i64) -> Result<u64, libsql::Error> {
        let cutoff = now_ms() - max_age_ms;
        self.conn()?
            .execute("DELETE FROM chat_log WHERE sent_at < ?1", params![cutoff])
            .await
    }

    /// Insert a chat line with an explicit timestamp, to exercise the retention purge.
    #[cfg(test)]
    pub(crate) async fn add_chat_at(
        &self,
        tenant: &str,
        name: &str,
        text: &str,
        sent_at: i64,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO chat_log (tenant, name, text, sent_at) VALUES (?1, ?2, ?3, ?4)",
                params![tenant, name, text, sent_at],
            )
            .await?;
        Ok(())
    }

    /// Insert a timeline event with an explicit timestamp, to exercise the retention purge.
    #[cfg(test)]
    pub(crate) async fn add_event_at(
        &self,
        tenant: &str,
        account_id: &str,
        created_at: i64,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO events (tenant, account_id, kind, name, detail, created_at)
                 VALUES (?1, ?2, 'test', '', '', ?3)",
                params![tenant, account_id, created_at],
            )
            .await?;
        Ok(())
    }

    /// Insert a play-time window with an explicit start, to exercise the retention purge.
    #[cfg(test)]
    pub(crate) async fn add_playtime_at(
        &self,
        tenant: &str,
        account_id: &str,
        window_start_ms: i64,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO playtime (tenant, account_id, window_start_ms, used_ms)
                 VALUES (?1, ?2, ?3, 0)",
                params![tenant, account_id, window_start_ms],
            )
            .await?;
        Ok(())
    }

    /// Milliseconds the account has played inside the current window (0 if the window has rolled over).
    pub async fn playtime_used(
        &self,
        tenant: &str,
        account_id: &str,
        window_ms: i64,
        now_ms: i64,
    ) -> Result<i64, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT window_start_ms, used_ms FROM playtime WHERE tenant = ?1 AND account_id = ?2",
                params![tenant, account_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => {
                let start = row.get::<i64>(0)?;
                if now_ms - start > window_ms {
                    return Ok(0);
                }
                Ok(row.get::<i64>(1)?)
            }
            None => Ok(0),
        }
    }

    /// Add `delta_ms` to the account's used time, rolling the window over when it has expired. Returns
    /// the used total after the update.
    pub async fn add_playtime(
        &self,
        tenant: &str,
        account_id: &str,
        delta_ms: i64,
        window_ms: i64,
        now_ms: i64,
    ) -> Result<i64, libsql::Error> {
        let used = self
            .playtime_used(tenant, account_id, window_ms, now_ms)
            .await?;
        let fresh = used == 0;
        let new_used = used + delta_ms;
        if fresh {
            self.conn()?
                .execute(
                    "INSERT INTO playtime (tenant, account_id, window_start_ms, used_ms)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(tenant, account_id) DO UPDATE SET window_start_ms = ?3, used_ms = ?4",
                    params![tenant, account_id, now_ms, new_used],
                )
                .await?;
        } else {
            self.conn()?
                .execute(
                    "UPDATE playtime SET used_ms = ?3 WHERE tenant = ?1 AND account_id = ?2",
                    params![tenant, account_id, new_used],
                )
                .await?;
        }
        Ok(new_used)
    }

    /// Raw tenant upsert. Kept separate from `ensure()` so seeding never re-enters schema
    /// setup, which would deadlock on the connection.
    async fn insert_tenant(&self, tenant: &Tenant) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO tenants (id, name, image, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, image=excluded.image",
                params![
                    tenant.id.clone(),
                    tenant.name.clone(),
                    tenant.image.clone(),
                    now_ms(),
                ],
            )
            .await?;
        Ok(())
    }

    pub async fn get_tenant(&self, id: &str) -> Result<Option<Tenant>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT id, name, image, playtime_limit_min, playtime_window_h, online_allowed, \
                 offline_allowed FROM tenants WHERE id = ?1",
                params![id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(row_to_tenant(&row)?)),
            None => Ok(None),
        }
    }

    pub async fn list_tenants(&self) -> Result<Vec<Tenant>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT id, name, image, playtime_limit_min, playtime_window_h, online_allowed, \
                 offline_allowed FROM tenants ORDER BY created_at ASC",
                (),
            )
            .await?;
        let mut tenants = Vec::new();
        while let Some(row) = rows.next().await? {
            tenants.push(row_to_tenant(&row)?);
        }
        Ok(tenants)
    }

    pub async fn upsert_tenant(&self, tenant: &Tenant) -> Result<Option<Tenant>, libsql::Error> {
        self.insert_tenant(tenant).await?;
        self.get_tenant(&tenant.id).await
    }

    pub async fn delete_tenant(&self, id: &str) -> Result<(), libsql::Error> {
        self.conn()?
            .execute("DELETE FROM tenants WHERE id = ?1", params![id])
            .await?;
        Ok(())
    }

    pub async fn top_scores(
        &self,
        tenant: &str,
        limit: u32,
    ) -> Result<Vec<ScoreEntry>, libsql::Error> {
        let clamped = limit.clamp(1, MAX_TOP_LIMIT) as i64;
        let mut rows = self
            .conn()?
            .query(
                "SELECT a.name, l.score FROM leaderboard l
                 JOIN accounts a ON a.account_id = l.account_id
                 WHERE l.tenant = ?1 ORDER BY l.score DESC, l.created_at ASC LIMIT ?2",
                params![tenant.trim(), clamped],
            )
            .await?;
        let mut scores = Vec::new();
        while let Some(row) = rows.next().await? {
            scores.push(ScoreEntry {
                name: row.get::<String>(0)?,
                score: row.get::<i64>(1)?,
            });
        }
        Ok(scores)
    }

    /// Top scores whose best was set on/after `since_ms` — the "last N days" leaderboard view.
    pub async fn top_scores_since(
        &self,
        tenant: &str,
        since_ms: i64,
        limit: u32,
    ) -> Result<Vec<ScoreEntry>, libsql::Error> {
        let clamped = limit.clamp(1, MAX_TOP_LIMIT) as i64;
        let mut rows = self
            .conn()?
            .query(
                "SELECT a.name, l.score FROM leaderboard l
                 JOIN accounts a ON a.account_id = l.account_id
                 WHERE l.tenant = ?1 AND l.created_at >= ?2
                 ORDER BY l.score DESC, l.created_at ASC LIMIT ?3",
                params![tenant.trim(), since_ms, clamped],
            )
            .await?;
        let mut scores = Vec::new();
        while let Some(row) = rows.next().await? {
            scores.push(ScoreEntry {
                name: row.get::<String>(0)?,
                score: row.get::<i64>(1)?,
            });
        }
        Ok(scores)
    }

    /// Authoritative score write keyed on the stable account: keeps the best score per account.
    /// The leaderboard always renders the account's CURRENT name via the JOIN above.
    pub async fn submit_score(&self, account_id: &str, score: i64) -> Result<(), libsql::Error> {
        if score < 0 {
            return Ok(());
        }
        self.conn()?
            .execute(
                "INSERT INTO leaderboard (tenant, account_id, score, created_at)
                 SELECT a.tenant, a.account_id, ?2, ?3 FROM accounts a WHERE a.account_id = ?1
                 ON CONFLICT(tenant, account_id) DO UPDATE SET
                    score = MAX(leaderboard.score, excluded.score),
                    created_at = excluded.created_at",
                params![account_id, score, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// Wipe every leaderboard score for a tenant (the admin "reset everyone's score" action).
    pub async fn reset_scores(&self, tenant: &str) -> Result<(), libsql::Error> {
        self.conn()?
            .execute("DELETE FROM leaderboard WHERE tenant = ?1", params![tenant])
            .await?;
        Ok(())
    }

    /// Wipe the tenant's activity history: the chat log and the event timeline (the join backlog). Both
    /// tables are per-tenant, so this only ever touches the calling admin's own world.
    pub async fn clear_history(&self, tenant: &str) -> Result<(), libsql::Error> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM chat_log WHERE tenant = ?1", params![tenant])
            .await?;
        conn.execute("DELETE FROM events WHERE tenant = ?1", params![tenant])
            .await?;
        Ok(())
    }

    // ---------- Identity: accounts, magic links, claims, events ----------

    pub async fn get_account_by_email(
        &self,
        tenant: &str,
        email: &str,
    ) -> Result<Option<Account>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT account_id, name, is_admin, is_moderator FROM accounts WHERE tenant = ?1 AND email = ?2",
                params![tenant, email],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                account_id: row.get::<String>(0)?,
                tenant: tenant.to_string(),
                name: row.get::<String>(1)?,
                email: email.to_string(),
                is_admin: row.get::<i64>(2)? != 0,
                is_moderator: row.get::<i64>(3)? != 0,
            })),
            None => Ok(None),
        }
    }

    pub async fn get_account_by_name(
        &self,
        tenant: &str,
        name: &str,
    ) -> Result<Option<Account>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT account_id, email, is_admin, is_moderator FROM accounts WHERE tenant = ?1 AND name = ?2",
                params![tenant, name],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                account_id: row.get::<String>(0)?,
                tenant: tenant.to_string(),
                name: name.to_string(),
                email: row.get::<String>(1)?,
                is_admin: row.get::<i64>(2)? != 0,
                is_moderator: row.get::<i64>(3)? != 0,
            })),
            None => Ok(None),
        }
    }

    pub async fn get_account_by_id(
        &self,
        account_id: &str,
    ) -> Result<Option<Account>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT tenant, email, name, is_admin, is_moderator FROM accounts WHERE account_id = ?1",
                params![account_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                account_id: account_id.to_string(),
                tenant: row.get::<String>(0)?,
                email: row.get::<String>(1)?,
                name: row.get::<String>(2)?,
                is_admin: row.get::<i64>(3)? != 0,
                is_moderator: row.get::<i64>(4)? != 0,
            })),
            None => Ok(None),
        }
    }

    /// Set the admin flag on the `(tenant, name)` account. Admin and moderator are mutually exclusive,
    /// so granting admin clears moderator in the same atomic update; revoking it leaves moderator alone.
    /// Returns false if no such account exists, so the /admin panel can report an unknown name instead
    /// of silently succeeding.
    pub async fn set_admin_by_name(
        &self,
        tenant: &str,
        name: &str,
        admin: bool,
    ) -> Result<bool, libsql::Error> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE accounts SET is_admin = ?3, is_moderator = is_moderator AND ?3 = 0 \
                 WHERE tenant = ?1 AND name = ?2",
                params![tenant, name, admin as i64],
            )
            .await?;
        Ok(changed > 0)
    }

    pub async fn set_admin_by_email(
        &self,
        tenant: &str,
        email: &str,
        admin: bool,
    ) -> Result<bool, libsql::Error> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE accounts SET is_admin = ?3, is_moderator = is_moderator AND ?3 = 0 \
                 WHERE tenant = ?1 AND email = ?2",
                params![tenant, email, admin as i64],
            )
            .await?;
        if changed > 0 {
            return Ok(true);
        }
        // No account for this email yet (they have never logged in). When GRANTING, pre-create a
        // pending account so the role is waiting for them: claim_account matches by email on first
        // login and keeps the role. Revoking a non-existent account is just a no-op.
        if !admin {
            return Ok(false);
        }
        self.pre_authorize_account(tenant, email, true, false).await
    }

    /// Create a placeholder account for an email that has never logged in, carrying a pre-granted role
    /// so an admin can authorize someone before their first login. The name is set to the email (it is
    /// NOT NULL and unique per tenant); `claim_account` renames it to the player's chosen name on first
    /// login and preserves the role.
    async fn pre_authorize_account(
        &self,
        tenant: &str,
        email: &str,
        admin: bool,
        moderator: bool,
    ) -> Result<bool, libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO accounts (account_id, tenant, email, name, is_admin, is_moderator, created_at) \
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)",
                params![gen_account_id(), tenant, email, admin as i64, moderator as i64, now_ms()],
            )
            .await?;
        Ok(true)
    }

    /// Set the moderator flag on the `(tenant, name)` account. Granting moderator clears admin in the
    /// same atomic update (the two roles are mutually exclusive); revoking it leaves admin alone.
    pub async fn set_moderator_by_name(
        &self,
        tenant: &str,
        name: &str,
        moderator: bool,
    ) -> Result<bool, libsql::Error> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE accounts SET is_moderator = ?3, is_admin = is_admin AND ?3 = 0 \
                 WHERE tenant = ?1 AND name = ?2",
                params![tenant, name, moderator as i64],
            )
            .await?;
        Ok(changed > 0)
    }

    pub async fn set_moderator_by_email(
        &self,
        tenant: &str,
        email: &str,
        moderator: bool,
    ) -> Result<bool, libsql::Error> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE accounts SET is_moderator = ?3, is_admin = is_admin AND ?3 = 0 \
                 WHERE tenant = ?1 AND email = ?2",
                params![tenant, email, moderator as i64],
            )
            .await?;
        if changed > 0 {
            return Ok(true);
        }
        // Same pre-authorization as admin: granting moderator to an email that never logged in creates
        // a pending account that keeps the role at first login; revoking a non-existent one is a no-op.
        if !moderator {
            return Ok(false);
        }
        self.pre_authorize_account(tenant, email, false, true).await
    }

    /// Whether the account is a room admin. Unknown accounts are not admins.
    pub async fn is_admin(&self, account_id: &str) -> Result<bool, libsql::Error> {
        match self.get_account_by_id(account_id).await? {
            Some(account) => Ok(account.is_admin),
            None => Ok(false),
        }
    }

    /// The account's capability tier. Unknown accounts are plain players.
    pub async fn role(&self, account_id: &str) -> Result<Role, libsql::Error> {
        match self.get_account_by_id(account_id).await? {
            Some(account) => Ok(account.role()),
            None => Ok(Role::Player),
        }
    }

    /// Set an account's role by stable id (used for in-game promote/demote of an online player).
    /// Returns false when no such account exists.
    pub async fn set_role(&self, account_id: &str, role: Role) -> Result<bool, libsql::Error> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE accounts SET is_admin = ?2, is_moderator = ?3 WHERE account_id = ?1",
                params![
                    account_id,
                    role.is_admin() as i64,
                    role.is_moderator() as i64
                ],
            )
            .await?;
        Ok(changed > 0)
    }

    /// Every account of a tenant for the /admin panel, oldest-first.
    pub async fn list_accounts(&self, tenant: &str) -> Result<Vec<AccountInfo>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT account_id, name, email, is_admin, is_moderator FROM accounts
                 WHERE tenant = ?1 ORDER BY created_at ASC",
                params![tenant],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(AccountInfo {
                account_id: row.get::<String>(0)?,
                name: row.get::<String>(1)?,
                email: row.get::<String>(2)?,
                is_admin: row.get::<i64>(3)? != 0,
                is_moderator: row.get::<i64>(4)? != 0,
            });
        }
        Ok(out)
    }

    /// How many accounts a tenant has. Used to make the first registered account its admin.
    pub async fn account_count(&self, tenant: &str) -> Result<i64, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT COUNT(*) AS n FROM accounts WHERE tenant = ?1",
                params![tenant],
            )
            .await?;
        match rows.next().await? {
            Some(row) => row.get::<i64>(0),
            None => Ok(0),
        }
    }

    /// Find-or-create the account for `(tenant, email)`, then adopt `name` as its display name only
    /// if that name is free in the tenant; otherwise keep the current name and report not renamed.
    pub async fn claim_account(
        &self,
        tenant: &str,
        email: &str,
        name: &str,
    ) -> Result<ClaimedAccount, libsql::Error> {
        if let Some(existing) = self.get_account_by_email(tenant, email).await? {
            if existing.name == name {
                return Ok(ClaimedAccount {
                    account_id: existing.account_id,
                    name: existing.name.clone(),
                    renamed: false,
                    old_name: existing.name,
                    is_admin: existing.is_admin,
                    is_moderator: existing.is_moderator,
                });
            }
            let old_name = existing.name.clone();
            if self
                .rename_account(&existing.account_id, name)
                .await?
                .is_none()
            {
                return Ok(ClaimedAccount {
                    account_id: existing.account_id,
                    name: old_name.clone(),
                    renamed: false,
                    old_name,
                    is_admin: existing.is_admin,
                    is_moderator: existing.is_moderator,
                });
            }
            return Ok(ClaimedAccount {
                account_id: existing.account_id,
                name: name.to_string(),
                renamed: true,
                old_name,
                is_admin: existing.is_admin,
                is_moderator: existing.is_moderator,
            });
        }
        let account_id = gen_account_id();
        // The first registered account of a tenant becomes its admin automatically.
        let first_in_tenant = self.account_count(tenant).await? == 0;
        self.conn()?
            .execute(
                "INSERT INTO accounts (account_id, tenant, email, name, is_admin, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    account_id.clone(),
                    tenant,
                    email,
                    name,
                    first_in_tenant as i64,
                    now_ms()
                ],
            )
            .await?;
        Ok(ClaimedAccount {
            account_id,
            name: name.to_string(),
            renamed: false,
            old_name: name.to_string(),
            is_admin: first_in_tenant,
            is_moderator: false,
        })
    }

    /// Rename an account if `new_name` is free in its tenant. Returns the previous name, or `None`
    /// when the new name is taken (or the account is unknown).
    pub async fn rename_account(
        &self,
        account_id: &str,
        new_name: &str,
    ) -> Result<Option<String>, libsql::Error> {
        let Some(account) = self.get_account_by_id(account_id).await? else {
            return Ok(None);
        };
        if account.name == new_name {
            return Ok(Some(account.name));
        }
        if self
            .get_account_by_name(&account.tenant, new_name)
            .await?
            .is_some()
        {
            return Ok(None);
        }
        self.conn()?
            .execute(
                "UPDATE accounts SET name = ?2 WHERE account_id = ?1",
                params![account_id, new_name],
            )
            .await?;
        Ok(Some(account.name))
    }

    pub async fn create_magic_link(
        &self,
        token: &str,
        code: &str,
        tenant: &str,
        name: &str,
        email: &str,
        ttl_ms: i64,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO magic_links (token, code, tenant, name, email, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![token, code, tenant, name, email, now_ms() + ttl_ms],
            )
            .await?;
        Ok(())
    }

    /// Consume the link matching `token` (or `tenant`+`name`+`code`); returns the identity it
    /// unlocks and removes it so it can be used only once. Expired links never match.
    pub async fn consume_magic_link(
        &self,
        token: Option<&str>,
        code: Option<(&str, &str, &str)>,
    ) -> Result<Option<MagicLink>, libsql::Error> {
        let mut rows = match (token, code) {
            (Some(tok), _) => {
                self.conn()?
                    .query(
                        "SELECT token, tenant, name, email FROM magic_links WHERE token = ?1 AND expires_at > ?2",
                        params![tok, now_ms()],
                    )
                    .await?
            }
            (None, Some((tenant, name, c))) => {
                self.conn()?
                    .query(
                        "SELECT token, tenant, name, email FROM magic_links
                         WHERE tenant = ?1 AND name = ?2 AND code = ?3 AND expires_at > ?4",
                        params![tenant, name, c, now_ms()],
                    )
                    .await?
            }
            (None, None) => return Ok(None),
        };
        let Some(row) = rows.next().await? else {
            return Ok(None);
        };
        let found_token = row.get::<String>(0)?;
        let link = MagicLink {
            tenant: row.get::<String>(1)?,
            name: row.get::<String>(2)?,
            email: row.get::<String>(3)?,
        };
        self.conn()?
            .execute(
                "DELETE FROM magic_links WHERE token = ?1",
                params![found_token],
            )
            .await?;
        Ok(Some(link))
    }

    /// Make `token` the active claim for an account, replacing any previous one.
    pub async fn set_claim(&self, account_id: &str, token: &str) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO device_claims (token, account_id, tenant, created_at)
                 SELECT ?2, a.account_id, a.tenant, ?3 FROM accounts a WHERE a.account_id = ?1
                 ON CONFLICT(token) DO UPDATE SET created_at = excluded.created_at",
                params![account_id, token, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// Resolve a live claim `token` within a tenant to its account_id + current name.
    pub async fn claim_to_account(
        &self,
        tenant: &str,
        token: &str,
    ) -> Result<Option<(String, String)>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT c.account_id, a.name FROM device_claims c
                 JOIN accounts a ON a.account_id = c.account_id
                 WHERE c.tenant = ?1 AND c.token = ?2",
                params![tenant, token],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some((row.get::<String>(0)?, row.get::<String>(1)?))),
            None => Ok(None),
        }
    }

    /// Drop the active claim for an account, only if `token` is the one currently held (logout).
    pub async fn clear_claim(&self, account_id: &str, token: &str) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "DELETE FROM device_claims WHERE account_id = ?1 AND token = ?2",
                params![account_id, token],
            )
            .await?;
        Ok(())
    }

    /// All active claims as (account_id, token), used to warm the in-memory claim map on startup.
    pub async fn all_claims(&self) -> Result<Vec<(String, String)>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query("SELECT account_id, token FROM device_claims", ())
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push((row.get::<String>(0)?, row.get::<String>(1)?));
        }
        Ok(out)
    }

    /// Append a persisted timeline event for an account (e.g. a rename).
    pub async fn record_event(
        &self,
        tenant: &str,
        account_id: &str,
        kind: &str,
        name: &str,
        detail: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO events (tenant, account_id, kind, name, detail, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![tenant, account_id, kind, name, detail, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// The most recent timeline events for a tenant, oldest-first so a joining client replays them
    /// in chronological order.
    pub async fn recent_events(
        &self,
        tenant: &str,
        limit: u32,
    ) -> Result<Vec<TimelineEvent>, libsql::Error> {
        let clamped = limit.clamp(1, MAX_EVENT_BACKLOG) as i64;
        let mut rows = self
            .conn()?
            .query(
                "SELECT kind, name, detail FROM (
                    SELECT id, kind, name, detail FROM events
                    WHERE tenant = ?1 ORDER BY id DESC LIMIT ?2
                 ) ORDER BY id ASC",
                params![tenant, clamped],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(TimelineEvent {
                kind: row.get::<String>(0)?,
                name: row.get::<String>(1)?,
                detail: row.get::<String>(2)?,
            });
        }
        Ok(out)
    }

    /// Persist a chat line, then prune anything past the retention window so the table self-trims.
    pub async fn record_chat(
        &self,
        tenant: &str,
        name: &str,
        text: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO chat_log (tenant, name, text, sent_at) VALUES (?1, ?2, ?3, ?4)",
                params![tenant, name, text, now_ms()],
            )
            .await?;
        self.purge_stale_chat(CHAT_RETENTION_MS).await?;
        Ok(())
    }

    /// The most recent chat lines for a tenant, newest-first, for the admin chat-log report.
    pub async fn recent_chat(
        &self,
        tenant: &str,
        limit: u32,
    ) -> Result<Vec<ChatEntry>, libsql::Error> {
        let clamped = limit.clamp(1, MAX_CHAT_BACKLOG) as i64;
        let mut rows = self
            .conn()?
            .query(
                "SELECT name, text, sent_at FROM chat_log
                 WHERE tenant = ?1 ORDER BY id DESC LIMIT ?2",
                params![tenant, clamped],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(ChatEntry {
                name: row.get::<String>(0)?,
                text: row.get::<String>(1)?,
                sent_at: row.get::<i64>(2)?,
            });
        }
        Ok(out)
    }

    /// Per-player play time accrued in each player's current window, most-played first, for the admin
    /// hours-played report. The key is the account id (or `ip:<addr>` for a guest) exactly as written.
    pub async fn playtime_report(
        &self,
        tenant: &str,
        limit: u32,
    ) -> Result<Vec<PlaytimeEntry>, libsql::Error> {
        let clamped = limit.clamp(1, MAX_REPORT_ROWS) as i64;
        let mut rows = self
            .conn()?
            .query(
                "SELECT account_id, used_ms FROM playtime
                 WHERE tenant = ?1 ORDER BY used_ms DESC, window_start_ms DESC LIMIT ?2",
                params![tenant, clamped],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(PlaytimeEntry {
                key: row.get::<String>(0)?,
                used_ms: row.get::<i64>(1)?,
            });
        }
        Ok(out)
    }

    /// Whether the account is approved to play in the tenant (only consulted when the gate is on).
    pub async fn is_approved(&self, tenant: &str, account_id: &str) -> Result<bool, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT 1 FROM approvals WHERE tenant = ?1 AND account_id = ?2",
                params![tenant, account_id],
            )
            .await?;
        Ok(rows.next().await?.is_some())
    }

    /// Approve an account: insert it into `approvals` and drop any pending request. Idempotent.
    pub async fn approve_account(
        &self,
        tenant: &str,
        account_id: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO approvals (tenant, account_id, approved_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(tenant, account_id) DO NOTHING",
                params![tenant, account_id, now_ms()],
            )
            .await?;
        self.clear_approval_request(tenant, account_id).await?;
        Ok(())
    }

    /// Record (or refresh) a pending request from an account held out by the gate, for the admin list.
    pub async fn record_approval_request(
        &self,
        tenant: &str,
        account_id: &str,
        name: &str,
        email: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO approval_requests (tenant, account_id, name, email, requested_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(tenant, account_id) DO UPDATE SET name = ?3, email = ?4, requested_at = ?5",
                params![tenant, account_id, name, email, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// Drop a held request entirely. Used when an approval is granted, when a one-shot reject is
    /// consumed (so a fresh join is held for approval again), and when a pending player is banned.
    pub async fn clear_approval_request(
        &self,
        tenant: &str,
        account_id: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "DELETE FROM approval_requests WHERE tenant = ?1 AND account_id = ?2",
                params![tenant, account_id],
            )
            .await?;
        Ok(())
    }

    /// Mark a held request rejected. The row stays (so the next join is turned away with "rejected");
    /// a later approve clears it.
    pub async fn reject_approval_request(
        &self,
        tenant: &str,
        account_id: &str,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "UPDATE approval_requests SET rejected = 1 WHERE tenant = ?1 AND account_id = ?2",
                params![tenant, account_id],
            )
            .await?;
        Ok(())
    }

    pub async fn is_rejected(&self, tenant: &str, account_id: &str) -> Result<bool, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT 1 FROM approval_requests WHERE tenant = ?1 AND account_id = ?2 AND rejected = 1",
                params![tenant, account_id],
            )
            .await?;
        Ok(rows.next().await?.is_some())
    }

    /// Every account still awaiting approval for a tenant, oldest-first, for the in-game admin list.
    /// Rejected requests are excluded (they are no longer "pending").
    pub async fn pending_approvals(
        &self,
        tenant: &str,
    ) -> Result<Vec<PendingApproval>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT account_id, name, email FROM approval_requests
                 WHERE tenant = ?1 AND rejected = 0 ORDER BY requested_at ASC",
                params![tenant],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(PendingApproval {
                account_id: row.get::<String>(0)?,
                name: row.get::<String>(1)?,
                email: row.get::<String>(2)?,
            });
        }
        Ok(out)
    }

    /// Email addresses of a tenant's admins, so a held-out join can notify the grown-ups.
    pub async fn tenant_admin_emails(&self, tenant: &str) -> Result<Vec<String>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query(
                "SELECT email FROM accounts WHERE tenant = ?1 AND is_admin = 1 ORDER BY created_at ASC",
                params![tenant],
            )
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get::<String>(0)?);
        }
        Ok(out)
    }

    /// Record an interested parent on the pre-launch waitlist. Re-submitting the same email refreshes
    /// their name/phone instead of failing, so the public form is idempotent.
    pub async fn add_waitlist_entry(
        &self,
        email: &str,
        name: Option<&str>,
        phone: Option<&str>,
    ) -> Result<(), libsql::Error> {
        self.conn()?
            .execute(
                "INSERT INTO waitlist (email, name, phone, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(email) DO UPDATE SET
                    name = excluded.name, phone = excluded.phone, created_at = excluded.created_at",
                params![email, name, phone, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// The emails currently on the waitlist, oldest-first. Test-only for now.
    #[cfg(test)]
    pub(crate) async fn waitlist_emails(&self) -> Result<Vec<String>, libsql::Error> {
        let mut rows = self
            .conn()?
            .query("SELECT email FROM waitlist ORDER BY id ASC", ())
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row.get::<String>(0)?);
        }
        Ok(out)
    }
}

pub fn default_top_limit() -> u32 {
    DEFAULT_TOP_LIMIT
}

pub fn default_event_backlog() -> u32 {
    DEFAULT_EVENT_BACKLOG
}

pub fn default_chat_backlog() -> u32 {
    DEFAULT_CHAT_BACKLOG
}

pub fn default_report_rows() -> u32 {
    DEFAULT_REPORT_ROWS
}

/// A stable, random account identifier (24 lowercase hex chars). The username is mutable; this is not.
fn gen_account_id() -> String {
    let mut rng = rand::thread_rng();
    (0..ACCOUNT_ID_HEX_CHARS)
        .map(|_| std::char::from_digit(rng.gen_range(0u32..16), 16).expect("0..16 is a hex digit"))
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_to_tenant(row: &libsql::Row) -> Result<Tenant, libsql::Error> {
    Ok(Tenant {
        id: row.get::<String>(0)?,
        name: row.get::<String>(1)?,
        image: row.get::<String>(2)?,
        playtime_limit_min: row.get::<i64>(3)? as u32,
        playtime_window_h: row.get::<i64>(4)? as u32,
        online_allowed: row.get::<i64>(5)? != 0,
        offline_allowed: row.get::<i64>(6)? != 0,
    })
}

/// Seed tenants: identical data to the web `BUILTIN_TENANTS`, so the shared db is consistent
/// whichever side seeds it first.
fn builtin_tenants() -> Vec<Tenant> {
    vec![
        Tenant {
            id: "acme".into(),
            name: "Acme".into(),
            image: "/default-avatar.png".into(),
            playtime_limit_min: 0,
            playtime_window_h: 0,
            online_allowed: true,
            offline_allowed: true,
        },
        Tenant {
            id: "demo".into(),
            name: "Blockland".into(),
            image: "/default-avatar.png".into(),
            playtime_limit_min: 0,
            playtime_window_h: 0,
            online_allowed: true,
            offline_allowed: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn memory_db() -> Db {
        Db::memory().await
    }

    #[tokio::test]
    async fn purge_stale_bans_drops_only_old_entries() {
        let db = memory_db().await;
        let day_ms = 24 * 60 * 60 * 1000;
        db.add_ban_at("203.0.113.1", now_ms() - 100 * day_ms)
            .await
            .unwrap();
        db.add_ban("203.0.113.2").await.unwrap();
        let removed = db.purge_stale_bans(90 * day_ms).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(db.all_bans().await.unwrap(), vec!["203.0.113.2"]);
    }

    #[tokio::test]
    async fn purge_stale_events_drops_only_old_entries() {
        let db = memory_db().await;
        let now = now_ms();
        let day_ms = 24 * 60 * 60 * 1000;
        db.add_event_at("acme", "old", now - 100 * day_ms)
            .await
            .unwrap();
        db.record_event("acme", "acc", "rename", "New", "Old")
            .await
            .unwrap();
        let removed = db.purge_stale_events(30 * day_ms).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(db.recent_events("acme", 20).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn purge_stale_playtime_drops_only_old_windows() {
        let db = memory_db().await;
        let now = now_ms();
        let day_ms = 24 * 60 * 60 * 1000;
        db.add_playtime_at("acme", "old", now - 100 * day_ms)
            .await
            .unwrap();
        db.add_playtime_at("acme", "new", now).await.unwrap();
        let removed = db.purge_stale_playtime(30 * day_ms).await.unwrap();
        assert_eq!(removed, 1);
    }

    #[tokio::test]
    async fn chat_log_records_reads_newest_first_and_isolates_tenants() {
        let db = memory_db().await;
        db.record_chat("acme", "Ann", "hello").await.unwrap();
        db.record_chat("acme", "Bob", "hi there").await.unwrap();
        // Another tenant's chat never leaks in.
        db.record_chat("demo", "Zoe", "elsewhere").await.unwrap();

        let chat = db
            .recent_chat("acme", default_chat_backlog())
            .await
            .unwrap();
        let lines: Vec<(&str, &str)> = chat
            .iter()
            .map(|c| (c.name.as_str(), c.text.as_str()))
            .collect();
        assert_eq!(lines, vec![("Bob", "hi there"), ("Ann", "hello")]);
    }

    #[tokio::test]
    async fn purge_stale_chat_drops_only_old_lines() {
        let db = memory_db().await;
        let now = now_ms();
        let day_ms = 24 * 60 * 60 * 1000;
        // Insert both lines without the self-prune (add_chat_at) so the explicit purge is what trims.
        db.add_chat_at("acme", "Old", "ancient", now - 100 * day_ms)
            .await
            .unwrap();
        db.add_chat_at("acme", "Ann", "fresh", now).await.unwrap();
        let removed = db.purge_stale_chat(30 * day_ms).await.unwrap();
        assert_eq!(removed, 1);
        let chat = db
            .recent_chat("acme", default_chat_backlog())
            .await
            .unwrap();
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].text, "fresh");
    }

    #[tokio::test]
    async fn record_chat_self_prunes_lines_past_retention() {
        let db = memory_db().await;
        let day_ms = 24 * 60 * 60 * 1000;
        db.add_chat_at("acme", "Old", "ancient", now_ms() - 100 * day_ms)
            .await
            .unwrap();
        // A fresh insert prunes anything already past the retention window.
        db.record_chat("acme", "Ann", "fresh").await.unwrap();
        let chat = db
            .recent_chat("acme", default_chat_backlog())
            .await
            .unwrap();
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].name, "Ann");
    }

    #[tokio::test]
    async fn playtime_report_aggregates_per_player_most_played_first() {
        let db = memory_db().await;
        let window = 1_000_000;
        db.add_playtime("acme", "ann-id", 400, window, 0)
            .await
            .unwrap();
        db.add_playtime("acme", "ip:203.0.113.7", 900, window, 0)
            .await
            .unwrap();
        // Another tenant's rows never leak in.
        db.add_playtime("demo", "zoe-id", 50, window, 0)
            .await
            .unwrap();

        let report = db
            .playtime_report("acme", default_report_rows())
            .await
            .unwrap();
        let rows: Vec<(&str, i64)> = report.iter().map(|r| (r.key.as_str(), r.used_ms)).collect();
        assert_eq!(rows, vec![("ip:203.0.113.7", 900), ("ann-id", 400)]);
    }

    #[tokio::test]
    async fn seeds_built_in_tenants() {
        let db = memory_db().await;
        let tenants = db.list_tenants().await.unwrap();
        let ids: Vec<String> = tenants.iter().map(|t| t.id.clone()).collect();
        assert!(ids.contains(&"acme".to_string()));
        assert!(ids.contains(&"demo".to_string()));
        assert!(tenants.iter().all(|t| t.image == "/default-avatar.png"));
    }

    #[tokio::test]
    async fn demo_tenant_has_a_playtime_budget_others_unlimited() {
        let db = memory_db().await;
        assert_eq!(db.tenant_playtime("demo").await.unwrap(), (5, 24));
        assert_eq!(db.tenant_playtime("acme").await.unwrap(), (0, 0));
    }

    #[tokio::test]
    async fn room_lease_same_owner_always_reacquires_and_renews() {
        let db = memory_db().await;
        let stale = 30_000;
        // Unheld -> taken.
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", 1_000, stale)
            .await
            .unwrap());
        // Already ours -> kept (a restart of the same instance re-acquires, never deadlocks).
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", 2_000, stale)
            .await
            .unwrap());
        // Renew refreshes the heartbeat without changing the owner.
        db.renew_room_lease("acme", "main", "srv-1", 3_000)
            .await
            .unwrap();
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", 4_000, stale)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn room_lease_refuses_a_fresh_owner_while_live_then_lets_it_take_over_when_stale() {
        let db = memory_db().await;
        let stale = 30_000;
        let live_now = 100_000;
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", live_now, stale)
            .await
            .unwrap());
        // A different instance is refused while srv-1's lease is still live (within the stale window).
        assert!(!db
            .acquire_room_lease("acme", "main", "srv-2", live_now + 1_000, stale)
            .await
            .unwrap());
        // srv-1 still owns it (the refused upsert left the row untouched).
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", live_now + 1_000, stale)
            .await
            .unwrap());
        // Once srv-1's heartbeat is older than the stale window, srv-2 takes over.
        let after_stale = live_now + 1_000 + stale + 1;
        assert!(db
            .acquire_room_lease("acme", "main", "srv-2", after_stale, stale)
            .await
            .unwrap());
        // And srv-1 can no longer reclaim it while srv-2 is live.
        assert!(!db
            .acquire_room_lease("acme", "main", "srv-1", after_stale + 1, stale)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn renew_and_release_only_touch_our_own_lease() {
        let db = memory_db().await;
        let stale = 30_000;
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", 1_000, stale)
            .await
            .unwrap());
        // A wrong-owner renew never refreshes the row, so it can still go stale and be retaken.
        db.renew_room_lease("acme", "main", "srv-2", 1_000_000)
            .await
            .unwrap();
        // A wrong-owner release never removes our row.
        db.release_room_lease("acme", "main", "srv-2")
            .await
            .unwrap();
        assert!(db
            .acquire_room_lease("acme", "main", "srv-1", 2_000, stale)
            .await
            .unwrap());
        // Our own release frees the room for a fresh different owner immediately.
        db.release_room_lease("acme", "main", "srv-1")
            .await
            .unwrap();
        assert!(db
            .acquire_room_lease("acme", "main", "srv-2", 3_000, stale)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn world_blob_round_trips_and_overwrites() {
        let db = memory_db().await;
        assert!(db.load_world("acme").await.unwrap().is_none());
        db.save_world("acme", &[1, 2, 3]).await.unwrap();
        assert_eq!(db.load_world("acme").await.unwrap(), Some(vec![1, 2, 3]));
        db.save_world("acme", &[9, 9]).await.unwrap();
        assert_eq!(db.load_world("acme").await.unwrap(), Some(vec![9, 9]));
        assert!(db.load_world("other").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn tenant_flags_default_off_and_round_trip() {
        let db = memory_db().await;
        assert_eq!(db.tenant_flags("acme").await.unwrap(), (false, false));
        db.set_tenant_suspended("acme", true).await.unwrap();
        db.set_tenant_approval_required("acme", true).await.unwrap();
        assert_eq!(db.tenant_flags("acme").await.unwrap(), (true, true));
        db.set_tenant_suspended("acme", false).await.unwrap();
        assert_eq!(db.tenant_flags("acme").await.unwrap(), (false, true));
    }

    #[tokio::test]
    async fn tenant_peace_defaults_calm_and_round_trips() {
        let db = memory_db().await;
        assert!(db.tenant_peace("acme").await.unwrap());
        db.set_tenant_peace("acme", false).await.unwrap();
        assert!(!db.tenant_peace("acme").await.unwrap());
        db.set_tenant_peace("acme", true).await.unwrap();
        assert!(db.tenant_peace("acme").await.unwrap());
    }

    #[tokio::test]
    async fn tenant_pvp_defaults_off_and_round_trips() {
        let db = memory_db().await;
        assert!(
            !db.tenant_pvp("acme").await.unwrap(),
            "pvp is off by default"
        );
        db.set_tenant_pvp("acme", true).await.unwrap();
        assert!(
            db.tenant_pvp("acme").await.unwrap(),
            "the admin's pvp toggle survives"
        );
    }

    #[tokio::test]
    async fn tenant_chat_defaults_on_and_round_trips() {
        let db = memory_db().await;
        assert!(
            db.tenant_chat_enabled("acme").await.unwrap(),
            "chat is on by default"
        );
        db.set_tenant_chat("acme", false).await.unwrap();
        assert!(
            !db.tenant_chat_enabled("acme").await.unwrap(),
            "the admin's chat-off survives a restart"
        );
    }

    #[tokio::test]
    async fn tenant_blocked_structures_default_empty_and_round_trip() {
        let db = memory_db().await;
        assert!(db
            .tenant_blocked_structures("acme")
            .await
            .unwrap()
            .is_empty());
        db.set_tenant_blocked_structures("acme", &["trophy".into(), "ball".into()])
            .await
            .unwrap();
        assert_eq!(
            db.tenant_blocked_structures("acme").await.unwrap(),
            vec!["trophy".to_string(), "ball".to_string()],
            "the blocked-structure set survives a restart",
        );
        db.set_tenant_blocked_structures("acme", &[]).await.unwrap();
        assert!(db
            .tenant_blocked_structures("acme")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn playtime_accrues_and_resets_with_the_window() {
        let db = memory_db().await;
        let window = 1000;
        assert_eq!(db.playtime_used("acme", "acc", window, 0).await.unwrap(), 0);
        assert_eq!(
            db.add_playtime("acme", "acc", 400, window, 0)
                .await
                .unwrap(),
            400
        );
        assert_eq!(
            db.playtime_used("acme", "acc", window, 100).await.unwrap(),
            400
        );
        assert_eq!(
            db.add_playtime("acme", "acc", 300, window, 200)
                .await
                .unwrap(),
            700
        );
        // once the window has rolled over, the used time resets
        assert_eq!(
            db.playtime_used("acme", "acc", window, 5000).await.unwrap(),
            0
        );
        assert_eq!(
            db.add_playtime("acme", "acc", 100, window, 5000)
                .await
                .unwrap(),
            100
        );
    }

    #[tokio::test]
    async fn tenant_roundtrip_upsert_get_delete() {
        let db = memory_db().await;
        let draft = Tenant {
            id: "acme".into(),
            name: "Acme".into(),
            image: "/tenants/acme/avatar.png".into(),
            playtime_limit_min: 0,
            playtime_window_h: 0,
            online_allowed: true,
            offline_allowed: true,
        };

        let saved = db.upsert_tenant(&draft).await.unwrap().unwrap();
        assert_eq!(saved.name, "Acme");
        assert_eq!(saved.image, "/tenants/acme/avatar.png");

        let fetched = db.get_tenant("acme").await.unwrap().unwrap();
        assert_eq!(fetched.image, "/tenants/acme/avatar.png");

        db.delete_tenant("acme").await.unwrap();
        assert!(db.get_tenant("acme").await.unwrap().is_none());
    }

    /// A db created with the old wide tenants schema (avatar + the 8 branding columns) migrates to the
    /// slim model on open: the `image` column is added and backfilled from `avatar`, the limit columns
    /// are added with their defaults, and the `Tenant` reads back without touching the dead columns.
    #[tokio::test]
    async fn legacy_wide_tenant_migrates_to_slim_image() {
        let database = Builder::new_local(":memory:").build().await.unwrap();
        let conn = database.connect().unwrap();
        conn.execute(
            "CREATE TABLE tenants (
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
            )",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO tenants (id, name, hero, title_a, title_b, tagline, primary_color,
                avatar, face_texture, face_block_name, created_at)
             VALUES ('old', 'Old', 'Hero', 'A', 'B', 'Tag', '#000',
                '/tenants/old/avatar.png', '/tenants/old/face.png', 'Old!', 1)",
            (),
        )
        .await
        .unwrap();

        let db = Db {
            database,
            shared: Some(conn),
        };
        db.ensure().await.unwrap();

        let migrated = db.get_tenant("old").await.unwrap().unwrap();
        assert_eq!(migrated.name, "Old");
        assert_eq!(migrated.image, "/tenants/old/avatar.png");

        // A brand-new tenant must insert cleanly into the migrated table: the dead NOT NULL branding
        // columns (hero, title_a, ...) are gone, so the slim id/name/image upsert no longer violates them.
        db.conn().unwrap()
            .execute(
                "INSERT INTO tenants (id, name, image, created_at) VALUES ('fresh', 'Fresh', '/x.png', 2)",
                (),
            )
            .await
            .expect("a new slim tenant inserts into a migrated legacy-wide table");
        assert_eq!(db.get_tenant("fresh").await.unwrap().unwrap().name, "Fresh");
    }

    /// Create an account by `(tenant, email)` claiming `name`, returning its stable id.
    async fn account(db: &Db, tenant: &str, email: &str, name: &str) -> String {
        db.claim_account(tenant, email, name)
            .await
            .unwrap()
            .account_id
    }

    #[tokio::test]
    async fn account_id_is_24_lowercase_hex() {
        let id = gen_account_id();
        assert_eq!(id.len(), ACCOUNT_ID_HEX_CHARS);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[tokio::test]
    async fn full_flow_account_submit_then_top_scores() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.submit_score(&ann, 42).await.unwrap();

        let top = db.top_scores("acme", default_top_limit()).await.unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].name, "Ann");
        assert_eq!(top[0].score, 42);
    }

    #[tokio::test]
    async fn top_scores_hides_rows_whose_account_was_wiped() {
        // The leaderboard JOINs scores onto accounts. If accounts are lost but score rows survive
        // (a half-restored db), the row silently vanishes from the board.
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.submit_score(&ann, 99).await.unwrap();
        db.conn()
            .unwrap()
            .execute("DELETE FROM accounts WHERE account_id = ?1", params![ann])
            .await
            .unwrap();

        assert!(db
            .top_scores("acme", default_top_limit())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn leaderboard_keeps_best_score_per_account() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.submit_score(&ann, 100).await.unwrap();
        db.submit_score(&ann, 10).await.unwrap();

        let top = db.top_scores("acme", default_top_limit()).await.unwrap();
        let ann_rows: Vec<&ScoreEntry> = top.iter().filter(|e| e.name == "Ann").collect();
        assert_eq!(ann_rows.len(), 1);
        assert_eq!(ann_rows[0].score, 100);
    }

    #[tokio::test]
    async fn leaderboard_orders_desc_and_isolates_tenants() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        let bob = account(&db, "acme", "bob@x.com", "Bob").await;
        let cid = account(&db, "acme", "cid@x.com", "Cid").await;
        let zoe = account(&db, "demo", "zoe@x.com", "Zoe").await;
        db.submit_score(&ann, 30).await.unwrap();
        db.submit_score(&bob, 50).await.unwrap();
        db.submit_score(&cid, 40).await.unwrap();
        db.submit_score(&zoe, 5).await.unwrap();

        let top = db.top_scores("acme", default_top_limit()).await.unwrap();
        let names: Vec<&str> = top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Bob", "Cid", "Ann"]);
    }

    #[tokio::test]
    async fn submit_score_rejects_negative_and_unknown_account() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.submit_score(&ann, -1).await.unwrap();
        db.submit_score("no-such-account", 5).await.unwrap();
        assert!(db
            .top_scores("acme", default_top_limit())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn rename_keeps_the_leaderboard_under_the_new_name() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.submit_score(&ann, 77).await.unwrap();

        let old = db.rename_account(&ann, "Annie").await.unwrap().unwrap();
        assert_eq!(old, "Ann");

        let top = db.top_scores("acme", default_top_limit()).await.unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].name, "Annie");
        assert_eq!(top[0].score, 77);
    }

    #[tokio::test]
    async fn rename_refuses_a_taken_name() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        account(&db, "acme", "bob@x.com", "Bob").await;
        assert!(db.rename_account(&ann, "Bob").await.unwrap().is_none());
        assert_eq!(
            db.get_account_by_id(&ann).await.unwrap().unwrap().name,
            "Ann"
        );
    }

    #[tokio::test]
    async fn reset_scores_wipes_only_its_own_tenant_leaderboard() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        let zoe = account(&db, "demo", "zoe@x.com", "Zoe").await;
        db.submit_score(&ann, 42).await.unwrap();
        db.submit_score(&zoe, 9).await.unwrap();

        db.reset_scores("acme").await.unwrap();

        assert!(db
            .top_scores("acme", default_top_limit())
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.top_scores("demo", default_top_limit())
                .await
                .unwrap()
                .len(),
            1,
            "another tenant's leaderboard is untouched"
        );
    }

    #[tokio::test]
    async fn clear_history_wipes_only_its_own_tenant_chat_and_events() {
        let db = memory_db().await;
        db.record_chat("acme", "Ann", "hi").await.unwrap();
        db.record_chat("demo", "Zoe", "yo").await.unwrap();
        db.record_event("acme", "acc-a", "rename", "Ann", "Annie")
            .await
            .unwrap();
        db.record_event("demo", "acc-z", "rename", "Zoe", "Zo")
            .await
            .unwrap();

        db.clear_history("acme").await.unwrap();

        assert!(db
            .recent_chat("acme", default_chat_backlog())
            .await
            .unwrap()
            .is_empty());
        assert!(db
            .recent_events("acme", default_event_backlog())
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            db.recent_chat("demo", default_chat_backlog())
                .await
                .unwrap()
                .len(),
            1,
            "another tenant's chat log is untouched"
        );
        assert_eq!(
            db.recent_events("demo", default_event_backlog())
                .await
                .unwrap()
                .len(),
            1,
            "another tenant's timeline is untouched"
        );
    }

    #[tokio::test]
    async fn claim_account_finds_or_creates_and_renames_when_free() {
        let db = memory_db().await;
        let first = db.claim_account("acme", "ann@x.com", "Ann").await.unwrap();
        assert!(!first.renamed);
        // Same email, new free name -> renames the same account.
        let second = db
            .claim_account("acme", "ann@x.com", "Annie")
            .await
            .unwrap();
        assert_eq!(second.account_id, first.account_id);
        assert!(second.renamed);
        assert_eq!(second.old_name, "Ann");
        assert_eq!(second.name, "Annie");
        // Same email, a name taken by someone else -> keeps current name, not renamed.
        account(&db, "acme", "bob@x.com", "Bob").await;
        let third = db.claim_account("acme", "ann@x.com", "Bob").await.unwrap();
        assert_eq!(third.account_id, first.account_id);
        assert!(!third.renamed);
        assert_eq!(third.name, "Annie");
    }

    #[tokio::test]
    async fn set_role_moves_an_account_between_tiers() {
        let db = memory_db().await;
        account(&db, "acme", "first@x.com", "First").await;
        let kid = account(&db, "acme", "kid@x.com", "Kid").await;
        assert_eq!(db.role(&kid).await.unwrap(), Role::Player);

        assert!(db.set_role(&kid, Role::Moderator).await.unwrap());
        assert_eq!(db.role(&kid).await.unwrap(), Role::Moderator);
        assert!(!db.is_admin(&kid).await.unwrap());

        assert!(db.set_role(&kid, Role::Admin).await.unwrap());
        assert_eq!(db.role(&kid).await.unwrap(), Role::Admin);
        assert!(db.is_admin(&kid).await.unwrap());

        assert!(db.set_role(&kid, Role::Player).await.unwrap());
        assert_eq!(db.role(&kid).await.unwrap(), Role::Player);
        assert!(!db.set_role("ghost", Role::Admin).await.unwrap());
    }

    #[tokio::test]
    async fn first_registered_account_of_a_tenant_is_admin() {
        let db = memory_db().await;
        let first = db.claim_account("acme", "ann@x.com", "Ann").await.unwrap();
        assert!(first.is_admin);
        assert!(db.is_admin(&first.account_id).await.unwrap());
        let second = db.claim_account("acme", "bob@x.com", "Bob").await.unwrap();
        assert!(!second.is_admin);
        assert!(!db.is_admin(&second.account_id).await.unwrap());
        // The count is per tenant: another tenant's first account is admin too.
        let other = db.claim_account("demo", "zoe@x.com", "Zoe").await.unwrap();
        assert!(other.is_admin);
        assert!(db.is_admin(&other.account_id).await.unwrap());
    }

    #[tokio::test]
    async fn claim_account_reports_admin_for_an_already_admin_account() {
        let db = memory_db().await;
        let ann = db.claim_account("acme", "ann@x.com", "Ann").await.unwrap();
        assert!(ann.is_admin);
        // Re-claiming the same account (same email) keeps reporting its admin flag.
        let again = db
            .claim_account("acme", "ann@x.com", "Annie")
            .await
            .unwrap();
        assert!(again.is_admin);
    }

    #[tokio::test]
    async fn set_admin_by_email_grants_revokes_existing_and_isolates_tenants() {
        let db = memory_db().await;
        // Seed the auto-admin first account so the account under test starts non-admin.
        account(&db, "acme", "first@x.com", "First").await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        assert!(!db.is_admin(&ann).await.unwrap());

        assert!(db
            .set_admin_by_email("acme", "ann@x.com", true)
            .await
            .unwrap());
        assert!(db.is_admin(&ann).await.unwrap());

        assert!(db
            .set_admin_by_email("acme", "ann@x.com", false)
            .await
            .unwrap());
        assert!(!db.is_admin(&ann).await.unwrap());

        // Revoking a role from an email that never existed is a harmless no-op — no row is created.
        assert!(!db
            .set_admin_by_email("acme", "nobody@x.com", false)
            .await
            .unwrap());
        assert!(db
            .get_account_by_email("acme", "nobody@x.com")
            .await
            .unwrap()
            .is_none());
        // Pre-authorizing in another tenant creates a SEPARATE account there and never touches acme.
        assert!(db
            .set_admin_by_email("demo", "ann@x.com", true)
            .await
            .unwrap());
        assert!(!db.is_admin(&ann).await.unwrap());
    }

    #[tokio::test]
    async fn granting_admin_by_email_pre_authorizes_a_player_who_never_logged_in() {
        let db = memory_db().await;
        // A regular player registers first, so the pre-authorized email is NOT the tenant's auto-admin.
        account(&db, "acme", "first@x.com", "First").await;

        // Grant admin to an email that has no account yet.
        assert!(db
            .set_admin_by_email("acme", "future@x.com", true)
            .await
            .unwrap());
        let pending = db
            .get_account_by_email("acme", "future@x.com")
            .await
            .unwrap()
            .unwrap();
        assert!(pending.is_admin);
        assert_eq!(pending.name, "future@x.com"); // placeholder until they pick a name

        // On first login they claim the email and choose a name; the admin role carries over.
        let claimed = db
            .claim_account("acme", "future@x.com", "Captain")
            .await
            .unwrap();
        assert!(claimed.is_admin);
        assert_eq!(claimed.name, "Captain");
        assert!(db.is_admin(&claimed.account_id).await.unwrap());

        // The same pre-authorization works for moderator.
        assert!(db
            .set_moderator_by_email("acme", "mod@x.com", true)
            .await
            .unwrap());
        let mod_claim = db.claim_account("acme", "mod@x.com", "Mod").await.unwrap();
        assert!(mod_claim.is_moderator);
        assert!(!mod_claim.is_admin);
    }

    #[tokio::test]
    async fn admin_flag_defaults_off_and_grants_then_revokes() {
        let db = memory_db().await;
        // The first account is auto-admin, so seed one before the account under test.
        account(&db, "acme", "first@x.com", "First").await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        assert!(!db.is_admin(&ann).await.unwrap());
        let before = db.get_account_by_id(&ann).await.unwrap().unwrap();
        assert!(!before.is_admin);

        assert!(db.set_admin_by_name("acme", "Ann", true).await.unwrap());
        assert!(db.is_admin(&ann).await.unwrap());
        let granted = db
            .get_account_by_name("acme", "Ann")
            .await
            .unwrap()
            .unwrap();
        assert!(granted.is_admin);

        assert!(db.set_admin_by_name("acme", "Ann", false).await.unwrap());
        assert!(!db.is_admin(&ann).await.unwrap());
    }

    #[tokio::test]
    async fn set_admin_reports_unknown_name_and_isolates_tenants() {
        let db = memory_db().await;
        // Seed the auto-admin first account so "Ann" is a plain (non-admin) account.
        account(&db, "acme", "first@x.com", "First").await;
        account(&db, "acme", "ann@x.com", "Ann").await;
        assert!(!db.set_admin_by_name("acme", "Nobody", true).await.unwrap());
        // A same-named account in another tenant is not affected.
        assert!(!db.set_admin_by_name("demo", "Ann", true).await.unwrap());
        let ann = db
            .get_account_by_name("acme", "Ann")
            .await
            .unwrap()
            .unwrap();
        assert!(!ann.is_admin);
    }

    #[tokio::test]
    async fn set_moderator_by_email_grants_revokes_existing_and_isolates_tenants() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        let role = |id: String| {
            let db = &db;
            async move { db.role(&id).await.unwrap() }
        };
        assert_eq!(role(ann.clone()).await, Role::Admin);

        // First account is auto-admin; clear it so moderator is the only flag under test.
        db.set_admin_by_email("acme", "ann@x.com", false)
            .await
            .unwrap();
        assert!(db
            .set_moderator_by_email("acme", "ann@x.com", true)
            .await
            .unwrap());
        assert_eq!(role(ann.clone()).await, Role::Moderator);

        assert!(db
            .set_moderator_by_email("acme", "ann@x.com", false)
            .await
            .unwrap());
        assert_eq!(role(ann.clone()).await, Role::Player);

        // Revoking from an email that never existed is a no-op (no row created).
        assert!(!db
            .set_moderator_by_email("acme", "nobody@x.com", false)
            .await
            .unwrap());
        assert!(db
            .get_account_by_email("acme", "nobody@x.com")
            .await
            .unwrap()
            .is_none());
        // Pre-authorizing in another tenant creates a SEPARATE account there and never touches acme.
        assert!(db
            .set_moderator_by_email("demo", "ann@x.com", true)
            .await
            .unwrap());
        assert_eq!(role(ann.clone()).await, Role::Player);
    }

    #[tokio::test]
    async fn set_moderator_by_name_grants_then_revokes_and_reports_unknown() {
        let db = memory_db().await;
        account(&db, "acme", "first@x.com", "First").await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        assert!(
            !db.get_account_by_id(&ann)
                .await
                .unwrap()
                .unwrap()
                .is_moderator
        );

        assert!(db.set_moderator_by_name("acme", "Ann", true).await.unwrap());
        assert!(
            db.get_account_by_name("acme", "Ann")
                .await
                .unwrap()
                .unwrap()
                .is_moderator
        );

        assert!(db
            .set_moderator_by_name("acme", "Ann", false)
            .await
            .unwrap());
        assert!(
            !db.get_account_by_id(&ann)
                .await
                .unwrap()
                .unwrap()
                .is_moderator
        );

        // Unknown name reports no change; a same-named account in another tenant is untouched.
        assert!(!db
            .set_moderator_by_name("acme", "Nobody", true)
            .await
            .unwrap());
        assert!(!db.set_moderator_by_name("demo", "Ann", true).await.unwrap());
    }

    #[tokio::test]
    async fn admin_and_moderator_are_mutually_exclusive() {
        let db = memory_db().await;
        // Seed the auto-admin first account so "Ann" starts as a plain player.
        account(&db, "acme", "first@x.com", "First").await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;

        // Granting moderator, then admin, clears the moderator flag in the same update.
        db.set_moderator_by_name("acme", "Ann", true).await.unwrap();
        db.set_admin_by_name("acme", "Ann", true).await.unwrap();
        let now_admin = db.get_account_by_id(&ann).await.unwrap().unwrap();
        assert!(now_admin.is_admin);
        assert!(!now_admin.is_moderator);
        assert_eq!(now_admin.role(), Role::Admin);

        // Granting moderator back clears the admin flag.
        db.set_moderator_by_name("acme", "Ann", true).await.unwrap();
        let now_moderator = db.get_account_by_id(&ann).await.unwrap().unwrap();
        assert!(!now_moderator.is_admin);
        assert!(now_moderator.is_moderator);
        assert_eq!(now_moderator.role(), Role::Moderator);

        // Revoking moderator (false) leaves the admin flag untouched.
        db.set_admin_by_name("acme", "Ann", true).await.unwrap();
        db.set_moderator_by_name("acme", "Ann", false)
            .await
            .unwrap();
        let still_admin = db.get_account_by_id(&ann).await.unwrap().unwrap();
        assert!(still_admin.is_admin);
        assert!(!still_admin.is_moderator);

        // Revoking admin (false) leaves the moderator flag untouched.
        db.set_moderator_by_name("acme", "Ann", true).await.unwrap();
        db.set_admin_by_name("acme", "Ann", false).await.unwrap();
        let still_moderator = db.get_account_by_id(&ann).await.unwrap().unwrap();
        assert!(!still_moderator.is_admin);
        assert!(still_moderator.is_moderator);
    }

    #[tokio::test]
    async fn unknown_account_is_not_admin() {
        let db = memory_db().await;
        assert!(!db.is_admin("no-such-account").await.unwrap());
    }

    #[tokio::test]
    async fn list_accounts_returns_tenant_accounts_with_admin_flag() {
        let db = memory_db().await;
        account(&db, "acme", "ann@x.com", "Ann").await;
        account(&db, "acme", "bob@x.com", "Bob").await;
        account(&db, "demo", "zoe@x.com", "Zoe").await;
        // Ann is the tenant's first account (auto-admin); clear it so only Bob is admin here.
        db.set_admin_by_name("acme", "Ann", false).await.unwrap();
        db.set_admin_by_name("acme", "Bob", true).await.unwrap();

        let accounts = db.list_accounts("acme").await.unwrap();
        let names: Vec<&str> = accounts.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["Ann", "Bob"]);
        let bob = accounts.iter().find(|a| a.name == "Bob").unwrap();
        assert!(bob.is_admin);
        assert_eq!(bob.email, "bob@x.com");
        let ann = accounts.iter().find(|a| a.name == "Ann").unwrap();
        assert!(!ann.is_admin);
    }

    #[tokio::test]
    async fn magic_link_unlocks_once_by_code_or_token() {
        let db = memory_db().await;
        assert!(db
            .get_account_by_name("acme", "Ann")
            .await
            .unwrap()
            .is_none());
        db.create_magic_link("tok1", "123456", "acme", "Ann", "a@b.com", 60_000)
            .await
            .unwrap();
        assert!(db
            .consume_magic_link(None, Some(("acme", "Ann", "000000")))
            .await
            .unwrap()
            .is_none());
        let link = db
            .consume_magic_link(None, Some(("acme", "Ann", "123456")))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(link.email, "a@b.com");
        assert_eq!(link.tenant, "acme");
        assert!(db
            .consume_magic_link(Some("tok1"), None)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn claims_keep_every_device_token_and_clear_one_at_a_time() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.set_claim(&ann, "tokA").await.unwrap();
        db.set_claim(&ann, "tokB").await.unwrap();
        // Both device tokens persist (a second device login never evicts the first).
        let mut all = db.all_claims().await.unwrap();
        all.sort();
        assert_eq!(
            all,
            vec![
                (ann.clone(), "tokA".to_string()),
                (ann.clone(), "tokB".to_string())
            ]
        );
        // Each token resolves to the account's current name (server-authoritative).
        assert_eq!(
            db.claim_to_account("acme", "tokA").await.unwrap(),
            Some((ann.clone(), "Ann".to_string()))
        );
        assert_eq!(
            db.claim_to_account("acme", "tokB").await.unwrap(),
            Some((ann.clone(), "Ann".to_string()))
        );
        // Logging out one device drops only that token; the other stays live.
        db.clear_claim(&ann, "tokA").await.unwrap();
        assert!(db.claim_to_account("acme", "tokA").await.unwrap().is_none());
        assert_eq!(
            db.all_claims().await.unwrap(),
            vec![(ann.clone(), "tokB".to_string())]
        );
        db.clear_claim(&ann, "tokB").await.unwrap();
        assert!(db.all_claims().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn events_log_records_and_replays_recent_first() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        db.record_event("acme", &ann, "rename", "Annie", "Ann")
            .await
            .unwrap();
        db.record_event("acme", &ann, "rename", "AnnieB", "Annie")
            .await
            .unwrap();
        // Another tenant's events never leak in.
        let zoe = account(&db, "demo", "zoe@x.com", "Zoe").await;
        db.record_event("demo", &zoe, "rename", "Zoey", "Zoe")
            .await
            .unwrap();

        let events = db
            .recent_events("acme", default_event_backlog())
            .await
            .unwrap();
        let pairs: Vec<(&str, &str)> = events
            .iter()
            .map(|e| (e.name.as_str(), e.detail.as_str()))
            .collect();
        assert_eq!(pairs, vec![("Annie", "Ann"), ("AnnieB", "Annie")]);
    }

    #[tokio::test]
    async fn approval_request_then_approve_clears_pending_and_marks_approved() {
        let db = memory_db().await;
        let ann = account(&db, "acme", "ann@x.com", "Ann").await;
        assert!(!db.is_approved("acme", &ann).await.unwrap());

        db.record_approval_request("acme", &ann, "Ann", "ann@x.com")
            .await
            .unwrap();
        let pending = db.pending_approvals("acme").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].account_id, ann);

        db.approve_account("acme", &ann).await.unwrap();
        assert!(db.is_approved("acme", &ann).await.unwrap());
        assert!(
            db.pending_approvals("acme").await.unwrap().is_empty(),
            "approving clears the pending request"
        );
    }

    #[tokio::test]
    async fn rejecting_a_request_drops_it_from_pending_and_marks_it_rejected() {
        let db = memory_db().await;
        let kid = account(&db, "acme", "kid@x.com", "Kid").await;
        db.record_approval_request("acme", &kid, "Kid", "kid@x.com")
            .await
            .unwrap();
        assert!(!db.is_rejected("acme", &kid).await.unwrap());

        db.reject_approval_request("acme", &kid).await.unwrap();
        assert!(db.is_rejected("acme", &kid).await.unwrap());
        assert!(!db.is_approved("acme", &kid).await.unwrap());
        assert!(
            db.pending_approvals("acme").await.unwrap().is_empty(),
            "a rejected request is no longer pending"
        );

        // A later approval overrides the rejection and clears the row.
        db.approve_account("acme", &kid).await.unwrap();
        assert!(db.is_approved("acme", &kid).await.unwrap());
        assert!(!db.is_rejected("acme", &kid).await.unwrap());
    }

    #[tokio::test]
    async fn tenant_admin_emails_lists_only_that_tenant_admins() {
        let db = memory_db().await;
        // The first account of a tenant is its admin.
        let _admin = account(&db, "acme", "parent@x.com", "Parent").await;
        let _kid = account(&db, "acme", "kid@x.com", "Kid").await;
        let _other = account(&db, "demo", "zoe@x.com", "Zoe").await;
        let emails = db.tenant_admin_emails("acme").await.unwrap();
        assert_eq!(emails, vec!["parent@x.com".to_string()]);
    }

    #[tokio::test]
    async fn waitlist_stores_optional_fields_and_dedupes_by_email() {
        let db = memory_db().await;
        db.add_waitlist_entry("ann@x.com", Some("Ann"), Some("+5511900000000"))
            .await
            .unwrap();
        db.add_waitlist_entry("bob@x.com", None, None)
            .await
            .unwrap();
        // Re-submitting the same email refreshes the row instead of adding a duplicate.
        db.add_waitlist_entry("ann@x.com", Some("Annie"), None)
            .await
            .unwrap();
        assert_eq!(
            db.waitlist_emails().await.unwrap(),
            vec!["ann@x.com".to_string(), "bob@x.com".to_string()]
        );
    }
}
