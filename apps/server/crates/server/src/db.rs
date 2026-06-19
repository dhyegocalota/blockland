//! The database lives here: a local libSQL file owned by this server. Next no longer talks
//! to libSQL directly; it proxies through the HMAC-signed internal API backed by this module.
//! `DATABASE_PATH` (default `./data/blocklandia.db`) points at the file; later a Turso URL +
//! token would swap into `Builder::new_remote` without changing any call site.

use libsql::{params, Builder, Connection, Database};
use rand::Rng;
use serde::{Deserialize, Serialize};

const DEFAULT_DATABASE_PATH: &str = "./data/blocklandia.db";
const DEFAULT_TOP_LIMIT: u32 = 10;
const MAX_TOP_LIMIT: u32 = 100;
const ACCOUNT_ID_HEX_CHARS: usize = 24;
const DEFAULT_EVENT_BACKLOG: u32 = 20;
const MAX_EVENT_BACKLOG: u32 = 100;

/// White-label branding plus landing-page copy for one tenant. Mirrors the `tenants` table
/// and the web `Tenant` interface field-for-field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: String,
    pub name: String,
    pub hero: String,
    #[serde(rename = "titleA")]
    pub title_a: String,
    #[serde(rename = "titleB")]
    pub title_b: String,
    pub tagline: String,
    pub primary: String,
    pub avatar: String,
    #[serde(rename = "faceTexture")]
    pub face_texture: String,
    #[serde(rename = "faceBlockName")]
    pub face_block_name: String,
}

/// One leaderboard row in the public top-scores view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreEntry {
    pub name: String,
    pub score: i64,
}

/// An account is identified by a stable `account_id`; the `name` is its current, MUTABLE display
/// name within a tenant. Identity is per tenant: `(tenant, email)` and `(tenant, name)` are unique.
#[derive(Debug, Clone)]
pub struct Account {
    pub account_id: String,
    pub tenant: String,
    pub name: String,
    pub email: String,
}

/// Result of finding-or-creating an account for `(tenant, email)`: the stable id, its current name,
/// and whether the requested name took effect (a free name renames; a taken name keeps the current).
#[derive(Debug, Clone)]
pub struct ClaimedAccount {
    pub account_id: String,
    pub name: String,
    pub renamed: bool,
    pub old_name: String,
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

/// Owns the libSQL handle. Cloneable connections are cheap; we hold the `Database` so the
/// file stays open for the process lifetime.
pub struct Db {
    _database: Database,
    conn: Connection,
}

impl Db {
    /// Open the local file db, create the schema, and seed the built-in tenants if empty.
    pub async fn open() -> Result<Self, libsql::Error> {
        let path =
            std::env::var("DATABASE_PATH").unwrap_or_else(|_| DEFAULT_DATABASE_PATH.to_string());
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let database = Builder::new_local(&path).build().await?;
        let conn = database.connect()?;
        let db = Self {
            _database: database,
            conn,
        };
        db.ensure().await?;
        Ok(db)
    }

    /// An ephemeral in-memory db with the schema applied; used by tests across the crate.
    #[cfg(test)]
    pub(crate) async fn memory() -> Self {
        let database = Builder::new_local(":memory:").build().await.unwrap();
        let conn = database.connect().unwrap();
        let db = Self {
            _database: database,
            conn,
        };
        db.ensure().await.unwrap();
        db
    }

    async fn ensure(&self) -> Result<(), libsql::Error> {
        self.conn
            .execute(
                "CREATE TABLE IF NOT EXISTS tenants (
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
            .await?;
        self.conn
            .execute(
                "CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY,
                    tenant TEXT NOT NULL,
                    email TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE (tenant, email),
                    UNIQUE (tenant, name)
                )",
                (),
            )
            .await?;
        self.conn
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
        self.conn
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
        self.conn
            .execute(
                "CREATE TABLE IF NOT EXISTS claims (
                    account_id TEXT PRIMARY KEY,
                    tenant TEXT NOT NULL,
                    token TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )",
                (),
            )
            .await?;
        self.conn
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

        let mut rows = self
            .conn
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
        }
        Ok(())
    }

    /// Raw tenant upsert. Kept separate from `ensure()` so seeding never re-enters schema
    /// setup, which would deadlock on the connection.
    async fn insert_tenant(&self, tenant: &Tenant) -> Result<(), libsql::Error> {
        self.conn
            .execute(
                "INSERT INTO tenants
                    (id, name, hero, title_a, title_b, tagline, primary_color, avatar,
                     face_texture, face_block_name, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, hero=excluded.hero, title_a=excluded.title_a,
                    title_b=excluded.title_b, tagline=excluded.tagline,
                    primary_color=excluded.primary_color, avatar=excluded.avatar,
                    face_texture=excluded.face_texture, face_block_name=excluded.face_block_name",
                params![
                    tenant.id.clone(),
                    tenant.name.clone(),
                    tenant.hero.clone(),
                    tenant.title_a.clone(),
                    tenant.title_b.clone(),
                    tenant.tagline.clone(),
                    tenant.primary.clone(),
                    tenant.avatar.clone(),
                    tenant.face_texture.clone(),
                    tenant.face_block_name.clone(),
                    now_ms(),
                ],
            )
            .await?;
        Ok(())
    }

    pub async fn get_tenant(&self, id: &str) -> Result<Option<Tenant>, libsql::Error> {
        let mut rows = self
            .conn
            .query("SELECT * FROM tenants WHERE id = ?1", params![id])
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(row_to_tenant(&row)?)),
            None => Ok(None),
        }
    }

    pub async fn list_tenants(&self) -> Result<Vec<Tenant>, libsql::Error> {
        let mut rows = self
            .conn
            .query("SELECT * FROM tenants ORDER BY created_at ASC", ())
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
        self.conn
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
            .conn
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
            .conn
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
        self.conn
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

    // ---------- Identity: accounts, magic links, claims, events ----------

    pub async fn get_account_by_email(
        &self,
        tenant: &str,
        email: &str,
    ) -> Result<Option<Account>, libsql::Error> {
        let mut rows = self
            .conn
            .query(
                "SELECT account_id, name FROM accounts WHERE tenant = ?1 AND email = ?2",
                params![tenant, email],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                account_id: row.get::<String>(0)?,
                tenant: tenant.to_string(),
                name: row.get::<String>(1)?,
                email: email.to_string(),
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
            .conn
            .query(
                "SELECT account_id, email FROM accounts WHERE tenant = ?1 AND name = ?2",
                params![tenant, name],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                account_id: row.get::<String>(0)?,
                tenant: tenant.to_string(),
                name: name.to_string(),
                email: row.get::<String>(1)?,
            })),
            None => Ok(None),
        }
    }

    pub async fn get_account_by_id(
        &self,
        account_id: &str,
    ) -> Result<Option<Account>, libsql::Error> {
        let mut rows = self
            .conn
            .query(
                "SELECT tenant, email, name FROM accounts WHERE account_id = ?1",
                params![account_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                account_id: account_id.to_string(),
                tenant: row.get::<String>(0)?,
                email: row.get::<String>(1)?,
                name: row.get::<String>(2)?,
            })),
            None => Ok(None),
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
                });
            }
            return Ok(ClaimedAccount {
                account_id: existing.account_id,
                name: name.to_string(),
                renamed: true,
                old_name,
            });
        }
        let account_id = gen_account_id();
        self.conn
            .execute(
                "INSERT INTO accounts (account_id, tenant, email, name, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![account_id.clone(), tenant, email, name, now_ms()],
            )
            .await?;
        Ok(ClaimedAccount {
            account_id,
            name: name.to_string(),
            renamed: false,
            old_name: name.to_string(),
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
        self.conn
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
        self.conn
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
                self.conn
                    .query(
                        "SELECT token, tenant, name, email FROM magic_links WHERE token = ?1 AND expires_at > ?2",
                        params![tok, now_ms()],
                    )
                    .await?
            }
            (None, Some((tenant, name, c))) => {
                self.conn
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
        self.conn
            .execute(
                "DELETE FROM magic_links WHERE token = ?1",
                params![found_token],
            )
            .await?;
        Ok(Some(link))
    }

    /// Make `token` the active claim for an account, replacing any previous one.
    pub async fn set_claim(&self, account_id: &str, token: &str) -> Result<(), libsql::Error> {
        self.conn
            .execute(
                "INSERT INTO claims (account_id, tenant, token, created_at)
                 SELECT a.account_id, a.tenant, ?2, ?3 FROM accounts a WHERE a.account_id = ?1
                 ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at",
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
            .conn
            .query(
                "SELECT c.account_id, a.name FROM claims c
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
        self.conn
            .execute(
                "DELETE FROM claims WHERE account_id = ?1 AND token = ?2",
                params![account_id, token],
            )
            .await?;
        Ok(())
    }

    /// All active claims as (account_id, token), used to warm the in-memory claim map on startup.
    pub async fn all_claims(&self) -> Result<Vec<(String, String)>, libsql::Error> {
        let mut rows = self
            .conn
            .query("SELECT account_id, token FROM claims", ())
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
        self.conn
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
            .conn
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
}

pub fn default_top_limit() -> u32 {
    DEFAULT_TOP_LIMIT
}

pub fn default_event_backlog() -> u32 {
    DEFAULT_EVENT_BACKLOG
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
        hero: row.get::<String>(2)?,
        title_a: row.get::<String>(3)?,
        title_b: row.get::<String>(4)?,
        tagline: row.get::<String>(5)?,
        primary: row.get::<String>(6)?,
        avatar: row.get::<String>(7)?,
        face_texture: row.get::<String>(8)?,
        face_block_name: row.get::<String>(9)?,
    })
}

/// Seed tenants: identical data to the web `BUILTIN_TENANTS`, so the shared db is consistent
/// whichever side seeds it first.
fn builtin_tenants() -> Vec<Tenant> {
    vec![
        Tenant {
            id: "teo".into(),
            name: "Teocraft".into(),
            hero: "Teodoro".into(),
            title_a: "TEO".into(),
            title_b: "CRAFT".into(),
            tagline: "O mundo mágico do <b>Teodoro</b>! Construa castelos, cace os porquinhos, derrote os monstrinhos e junte estrelas. Coloque o seu rosto em blocos pra deixar tudo do seu jeito! 🎉".into(),
            primary: "#ffd23f".into(),
            avatar: "/tenants/teo/avatar.png".into(),
            face_texture: "/tenants/teo/face.png".into(),
            face_block_name: "Teo!".into(),
        },
        Tenant {
            id: "demo".into(),
            name: "Blocklandia".into(),
            hero: "você".into(),
            title_a: "BLOCK".into(),
            title_b: "LANDIA".into(),
            tagline: "Seu mundo de blocos! Construa, cace os bichinhos, derrote os monstrinhos e junte estrelas. Coloque o seu rosto em blocos pra deixar tudo do seu jeito! 🎉".into(),
            primary: "#3dc6ff".into(),
            avatar: "/tenants/demo/avatar.png".into(),
            face_texture: "/tenants/demo/face.png".into(),
            face_block_name: "Eu!".into(),
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
    async fn seeds_built_in_tenants() {
        let db = memory_db().await;
        let ids: Vec<String> = db
            .list_tenants()
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert!(ids.contains(&"teo".to_string()));
        assert!(ids.contains(&"demo".to_string()));
    }

    #[tokio::test]
    async fn tenant_roundtrip_upsert_get_delete() {
        let db = memory_db().await;
        let draft = Tenant {
            id: "acme".into(),
            name: "Acme".into(),
            hero: "Wile".into(),
            title_a: "AC".into(),
            title_b: "ME".into(),
            tagline: "Beep beep".into(),
            primary: "#ff0000".into(),
            avatar: "/tenants/acme/avatar.png".into(),
            face_texture: "/tenants/acme/face.png".into(),
            face_block_name: "Me!".into(),
        };

        let saved = db.upsert_tenant(&draft).await.unwrap().unwrap();
        assert_eq!(saved.name, "Acme");
        assert_eq!(saved.title_a, "AC");

        let fetched = db.get_tenant("acme").await.unwrap().unwrap();
        assert_eq!(fetched.tagline, "Beep beep");

        db.delete_tenant("acme").await.unwrap();
        assert!(db.get_tenant("acme").await.unwrap().is_none());
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
    async fn leaderboard_keeps_best_score_per_account() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        db.submit_score(&ann, 100).await.unwrap();
        db.submit_score(&ann, 10).await.unwrap();

        let top = db.top_scores("teo", default_top_limit()).await.unwrap();
        let ann_rows: Vec<&ScoreEntry> = top.iter().filter(|e| e.name == "Ann").collect();
        assert_eq!(ann_rows.len(), 1);
        assert_eq!(ann_rows[0].score, 100);
    }

    #[tokio::test]
    async fn leaderboard_orders_desc_and_isolates_tenants() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        let bob = account(&db, "teo", "bob@x.com", "Bob").await;
        let cid = account(&db, "teo", "cid@x.com", "Cid").await;
        let zoe = account(&db, "demo", "zoe@x.com", "Zoe").await;
        db.submit_score(&ann, 30).await.unwrap();
        db.submit_score(&bob, 50).await.unwrap();
        db.submit_score(&cid, 40).await.unwrap();
        db.submit_score(&zoe, 5).await.unwrap();

        let top = db.top_scores("teo", default_top_limit()).await.unwrap();
        let names: Vec<&str> = top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Bob", "Cid", "Ann"]);
    }

    #[tokio::test]
    async fn submit_score_rejects_negative_and_unknown_account() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        db.submit_score(&ann, -1).await.unwrap();
        db.submit_score("no-such-account", 5).await.unwrap();
        assert!(db
            .top_scores("teo", default_top_limit())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn rename_keeps_the_leaderboard_under_the_new_name() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        db.submit_score(&ann, 77).await.unwrap();

        let old = db.rename_account(&ann, "Annie").await.unwrap().unwrap();
        assert_eq!(old, "Ann");

        let top = db.top_scores("teo", default_top_limit()).await.unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].name, "Annie");
        assert_eq!(top[0].score, 77);
    }

    #[tokio::test]
    async fn rename_refuses_a_taken_name() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        account(&db, "teo", "bob@x.com", "Bob").await;
        assert!(db.rename_account(&ann, "Bob").await.unwrap().is_none());
        assert_eq!(
            db.get_account_by_id(&ann).await.unwrap().unwrap().name,
            "Ann"
        );
    }

    #[tokio::test]
    async fn claim_account_finds_or_creates_and_renames_when_free() {
        let db = memory_db().await;
        let first = db.claim_account("teo", "ann@x.com", "Ann").await.unwrap();
        assert!(!first.renamed);
        // Same email, new free name -> renames the same account.
        let second = db.claim_account("teo", "ann@x.com", "Annie").await.unwrap();
        assert_eq!(second.account_id, first.account_id);
        assert!(second.renamed);
        assert_eq!(second.old_name, "Ann");
        assert_eq!(second.name, "Annie");
        // Same email, a name taken by someone else -> keeps current name, not renamed.
        account(&db, "teo", "bob@x.com", "Bob").await;
        let third = db.claim_account("teo", "ann@x.com", "Bob").await.unwrap();
        assert_eq!(third.account_id, first.account_id);
        assert!(!third.renamed);
        assert_eq!(third.name, "Annie");
    }

    #[tokio::test]
    async fn magic_link_unlocks_once_by_code_or_token() {
        let db = memory_db().await;
        assert!(db
            .get_account_by_name("teo", "Ann")
            .await
            .unwrap()
            .is_none());
        db.create_magic_link("tok1", "123456", "teo", "Ann", "a@b.com", 60_000)
            .await
            .unwrap();
        assert!(db
            .consume_magic_link(None, Some(("teo", "Ann", "000000")))
            .await
            .unwrap()
            .is_none());
        let link = db
            .consume_magic_link(None, Some(("teo", "Ann", "123456")))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(link.email, "a@b.com");
        assert_eq!(link.tenant, "teo");
        assert!(db
            .consume_magic_link(Some("tok1"), None)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn claims_replace_resolve_and_clear_by_token() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        db.set_claim(&ann, "tokA").await.unwrap();
        db.set_claim(&ann, "tokB").await.unwrap();
        assert_eq!(
            db.all_claims().await.unwrap(),
            vec![(ann.clone(), "tokB".to_string())]
        );
        // The live token resolves to the account's current name (server-authoritative).
        assert_eq!(
            db.claim_to_account("teo", "tokB").await.unwrap(),
            Some((ann.clone(), "Ann".to_string()))
        );
        assert!(db.claim_to_account("teo", "tokA").await.unwrap().is_none());
        // A stale token must not clear a re-claimed session.
        db.clear_claim(&ann, "tokA").await.unwrap();
        assert_eq!(db.all_claims().await.unwrap().len(), 1);
        db.clear_claim(&ann, "tokB").await.unwrap();
        assert!(db.all_claims().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn events_log_records_and_replays_recent_first() {
        let db = memory_db().await;
        let ann = account(&db, "teo", "ann@x.com", "Ann").await;
        db.record_event("teo", &ann, "rename", "Annie", "Ann")
            .await
            .unwrap();
        db.record_event("teo", &ann, "rename", "AnnieB", "Annie")
            .await
            .unwrap();
        // Another tenant's events never leak in.
        let zoe = account(&db, "demo", "zoe@x.com", "Zoe").await;
        db.record_event("demo", &zoe, "rename", "Zoey", "Zoe")
            .await
            .unwrap();

        let events = db
            .recent_events("teo", default_event_backlog())
            .await
            .unwrap();
        let pairs: Vec<(&str, &str)> = events
            .iter()
            .map(|e| (e.name.as_str(), e.detail.as_str()))
            .collect();
        assert_eq!(pairs, vec![("Annie", "Ann"), ("AnnieB", "Annie")]);
    }
}
