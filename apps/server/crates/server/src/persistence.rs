//! The write side-effects the in-game logic produces (playtime accrual, chat log, the leaderboard,
//! the world diff) behind a small sync, fire-and-forget seam. The game tick/handlers call these
//! and move on; the native server backs them with the real db (spawning the async write exactly as
//! before), while a future WASM/offline core backs them with a no-op (offline keeps no database).

use std::sync::Arc;

use crate::db::Db;

/// The in-game writes, each returning immediately. The native impl does the async db work (and logs
/// its own failures) internally; an offline impl drops them. This is the only persistence surface
/// the game logic may touch — admit-policy db READS (role/playtime/ban/approval) stay in `admit`.
pub trait Persistence: Send + Sync {
    /// Accrue a player's session delta into the play-time window (keyed by account or IP).
    fn accrue_playtime(&self, tenant: &str, key: &str, delta_ms: i64, window_ms: i64, now_ms: i64);
    /// Append a chat line to the tenant's chat log.
    fn record_chat(&self, tenant: &str, name: &str, text: &str);
    /// Persist a player's new total score to the leaderboard.
    fn submit_score(&self, account_id: &str, score: i64);
    /// Clear the tenant's persisted leaderboard.
    fn reset_scores(&self, tenant: &str);
    /// Persist the tenant's encoded world diff.
    fn flush_world(&self, tenant: &str, encoded_edits: Vec<u8>);
}

/// The native backing: every method spawns the same fire-and-forget db write the room used to spawn
/// inline, with the same `tracing::error!` on failure and the same cadence (the caller still decides
/// when to call). Holds the shared `Db` handle the room got from the hub.
pub struct DbPersistence {
    db: Arc<Db>,
}

impl DbPersistence {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

impl Persistence for DbPersistence {
    fn accrue_playtime(&self, tenant: &str, key: &str, delta_ms: i64, window_ms: i64, now_ms: i64) {
        let db = self.db.clone();
        let tenant = tenant.to_string();
        let key = key.to_string();
        tokio::spawn(async move {
            if let Err(e) = db
                .add_playtime(&tenant, &key, delta_ms, window_ms, now_ms)
                .await
            {
                tracing::error!(error = %e, "add_playtime failed");
            }
        });
    }

    fn record_chat(&self, tenant: &str, name: &str, text: &str) {
        let db = self.db.clone();
        let tenant = tenant.to_string();
        let name = name.to_string();
        let text = text.to_string();
        tokio::spawn(async move {
            if let Err(e) = db.record_chat(&tenant, &name, &text).await {
                tracing::error!(error = %e, "failed to persist chat");
            }
        });
    }

    fn submit_score(&self, account_id: &str, score: i64) {
        let db = self.db.clone();
        let account_id = account_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = db.submit_score(&account_id, score).await {
                tracing::error!(error = %e, "submit_score after kill failed");
            }
        });
    }

    fn reset_scores(&self, tenant: &str) {
        let db = self.db.clone();
        let tenant = tenant.to_string();
        tokio::spawn(async move {
            if let Err(e) = db.reset_scores(&tenant).await {
                tracing::error!(error = %e, "reset_scores failed");
            }
        });
    }

    fn flush_world(&self, tenant: &str, encoded_edits: Vec<u8>) {
        let db = self.db.clone();
        let tenant = tenant.to_string();
        tokio::spawn(async move {
            if let Err(e) = db.save_world(&tenant, &encoded_edits).await {
                tracing::error!(%tenant, error = %e, "world save failed");
            }
        });
    }
}
