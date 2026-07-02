//! The native backing for the game-core `Persistence` seam: every method spawns the same
//! fire-and-forget db write the room used to spawn inline. The trait itself lives in `game_core`;
//! a future WASM/offline core backs it with a no-op.

use std::sync::Arc;

use game_core::Persistence;

use crate::db::Db;

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

    fn clear_history(&self, tenant: &str) {
        let db = self.db.clone();
        let tenant = tenant.to_string();
        tokio::spawn(async move {
            if let Err(e) = db.clear_history(&tenant).await {
                tracing::error!(error = %e, "clear_history failed");
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
