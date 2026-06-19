//! The database lives here: a local libSQL file owned by this server. Next no longer talks
//! to libSQL directly; it proxies through the HMAC-signed internal API backed by this module.
//! `DATABASE_PATH` (default `./data/blocklandia.db`) points at the file; later a Turso URL +
//! token would swap into `Builder::new_remote` without changing any call site.

use libsql::{params, Builder, Connection, Database};
use serde::{Deserialize, Serialize};

const DEFAULT_DATABASE_PATH: &str = "./data/blocklandia.db";
const NAME_MAX_LENGTH: usize = 16;
const DEFAULT_TOP_LIMIT: u32 = 10;
const MAX_TOP_LIMIT: u32 = 100;

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

/// A username is owned by one email WITHIN A TENANT (identity is per tenant, not global). Only the
/// owner (proven by a magic link) may use that name in that tenant.
#[derive(Debug, Clone)]
pub struct Account {
    pub tenant: String,
    pub name: String,
    pub email: String,
}

/// A pending login: a clicked-link `token` and a typed `code` both unlock the same (tenant, name, email).
#[derive(Debug, Clone)]
pub struct MagicLink {
    pub tenant: String,
    pub name: String,
    pub email: String,
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
                "CREATE TABLE IF NOT EXISTS leaderboard (
                    tenant TEXT NOT NULL,
                    name TEXT NOT NULL,
                    score INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (tenant, name)
                )",
                (),
            )
            .await?;
        self.conn
            .execute(
                "CREATE TABLE IF NOT EXISTS accounts (
                    tenant TEXT NOT NULL,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (tenant, name)
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
                    tenant TEXT NOT NULL,
                    name TEXT NOT NULL,
                    token TEXT NOT NULL,
                    email TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (tenant, name)
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
                "SELECT name, score FROM leaderboard
                 WHERE tenant = ?1 ORDER BY score DESC, created_at ASC LIMIT ?2",
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
                "SELECT name, score FROM leaderboard
                 WHERE tenant = ?1 AND created_at >= ?2 ORDER BY score DESC, created_at ASC LIMIT ?3",
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

    /// Authoritative score write: keeps the best score per name, clamps the name length, and
    /// rejects invalid scores. Returns the stored entry, or `None` if the input was invalid.
    pub async fn submit_score(
        &self,
        tenant: &str,
        name: &str,
        score: i64,
    ) -> Result<Option<ScoreEntry>, libsql::Error> {
        let tenant = tenant.trim();
        let name = sanitize_name(name);
        if tenant.is_empty() || name.is_empty() || score < 0 {
            return Ok(None);
        }
        self.conn
            .execute(
                "INSERT INTO leaderboard (tenant, name, score, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(tenant, name) DO UPDATE SET
                    score = MAX(leaderboard.score, excluded.score),
                    created_at = excluded.created_at",
                params![tenant, name.clone(), score, now_ms()],
            )
            .await?;
        Ok(Some(ScoreEntry { name, score }))
    }

    // ---------- Identity: accounts, magic links, claims ----------

    pub async fn get_account(
        &self,
        tenant: &str,
        name: &str,
    ) -> Result<Option<Account>, libsql::Error> {
        let mut rows = self
            .conn
            .query(
                "SELECT email FROM accounts WHERE tenant = ?1 AND name = ?2",
                params![tenant, name],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Account {
                tenant: tenant.to_string(),
                name: name.to_string(),
                email: row.get::<String>(0)?,
            })),
            None => Ok(None),
        }
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

    pub async fn upsert_account(
        &self,
        tenant: &str,
        name: &str,
        email: &str,
    ) -> Result<(), libsql::Error> {
        self.conn
            .execute(
                "INSERT INTO accounts (tenant, name, email, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(tenant, name) DO UPDATE SET email = excluded.email",
                params![tenant, name, email, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// Make `token` the active claim for (tenant, name), replacing any previous one.
    pub async fn set_claim(
        &self,
        tenant: &str,
        name: &str,
        email: &str,
        token: &str,
    ) -> Result<(), libsql::Error> {
        self.conn
            .execute(
                "INSERT INTO claims (tenant, name, token, email, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(tenant, name) DO UPDATE SET token = excluded.token, email = excluded.email",
                params![tenant, name, token, email, now_ms()],
            )
            .await?;
        Ok(())
    }

    /// Drop the active claim for (tenant, name), only if `token` is the one currently held (logout).
    pub async fn clear_claim(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
    ) -> Result<(), libsql::Error> {
        self.conn
            .execute(
                "DELETE FROM claims WHERE tenant = ?1 AND name = ?2 AND token = ?3",
                params![tenant, name, token],
            )
            .await?;
        Ok(())
    }

    /// All active claims as (tenant, name, token), used to warm the in-memory claim map on startup.
    pub async fn all_claims(&self) -> Result<Vec<(String, String, String)>, libsql::Error> {
        let mut rows = self
            .conn
            .query("SELECT tenant, name, token FROM claims", ())
            .await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push((
                row.get::<String>(0)?,
                row.get::<String>(1)?,
                row.get::<String>(2)?,
            ));
        }
        Ok(out)
    }
}

pub fn default_top_limit() -> u32 {
    DEFAULT_TOP_LIMIT
}

fn sanitize_name(name: &str) -> String {
    name.trim().chars().take(NAME_MAX_LENGTH).collect()
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

    #[tokio::test]
    async fn leaderboard_keeps_best_score_per_name() {
        let db = memory_db().await;
        db.submit_score("teo", "Ann", 100).await.unwrap();
        db.submit_score("teo", "Ann", 10).await.unwrap();

        let top = db.top_scores("teo", default_top_limit()).await.unwrap();
        let ann: Vec<&ScoreEntry> = top.iter().filter(|e| e.name == "Ann").collect();
        assert_eq!(ann.len(), 1);
        assert_eq!(ann[0].score, 100);
    }

    #[tokio::test]
    async fn leaderboard_orders_desc_and_isolates_tenants() {
        let db = memory_db().await;
        db.submit_score("teo", "Ann", 30).await.unwrap();
        db.submit_score("teo", "Bob", 50).await.unwrap();
        db.submit_score("teo", "Cid", 40).await.unwrap();
        db.submit_score("demo", "Zoe", 5).await.unwrap();

        let top = db.top_scores("teo", default_top_limit()).await.unwrap();
        let names: Vec<&str> = top.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Bob", "Cid", "Ann"]);
    }

    #[tokio::test]
    async fn submit_score_rejects_invalid_input() {
        let db = memory_db().await;
        assert!(db.submit_score("teo", "  ", 5).await.unwrap().is_none());
        assert!(db.submit_score("teo", "Ann", -1).await.unwrap().is_none());
        assert!(db.submit_score("", "Ann", 5).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn magic_link_unlocks_once_by_code_or_token() {
        let db = memory_db().await;
        assert!(db.get_account("teo", "Ann").await.unwrap().is_none());
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
        db.upsert_account("teo", "Ann", "a@b.com").await.unwrap();
        assert_eq!(
            db.get_account("teo", "Ann").await.unwrap().unwrap().email,
            "a@b.com"
        );
        // Same name in another tenant is a separate, still-unclaimed account.
        assert!(db.get_account("demo", "Ann").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn claims_replace_and_clear_by_token() {
        let db = memory_db().await;
        db.set_claim("teo", "Ann", "a@b.com", "tokA").await.unwrap();
        db.set_claim("teo", "Ann", "a@b.com", "tokB").await.unwrap();
        assert_eq!(
            db.all_claims().await.unwrap(),
            vec![("teo".to_string(), "Ann".to_string(), "tokB".to_string())]
        );
        db.clear_claim("teo", "Ann", "tokA").await.unwrap();
        assert_eq!(db.all_claims().await.unwrap().len(), 1);
        db.clear_claim("teo", "Ann", "tokB").await.unwrap();
        assert!(db.all_claims().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn submit_score_truncates_long_names() {
        let db = memory_db().await;
        db.submit_score("names", "abcdefghijklmnopqrstuv", 1)
            .await
            .unwrap();
        let top = db.top_scores("names", default_top_limit()).await.unwrap();
        assert_eq!(top[0].name, "abcdefghijklmnop");
    }
}
