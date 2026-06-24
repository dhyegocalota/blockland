//! The write side-effects the in-game logic produces (playtime accrual, chat log, the leaderboard,
//! the world diff) behind a small sync, fire-and-forget seam. The game tick/handlers call these
//! and move on; the native server backs them with the real db (spawning the async write exactly as
//! before), while a future WASM/offline core backs them with a no-op (offline keeps no database).

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
