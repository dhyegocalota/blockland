//! Global IP ban list. A thread-safe set of banned `IpAddr` warmed from libSQL on startup and written
//! through to it on every ban/unban, so a restart restores the list. Lookups are lock-free on the hot
//! path via `DashSet`; the database is the durable source of truth (no separate file).

use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Arc;

use dashmap::DashSet;

use crate::db::Db;

pub struct Bans {
    ips: DashSet<IpAddr>,
    db: Arc<Db>,
}

impl Bans {
    /// Warm the in-memory set from the db. A db error starts empty and is logged; the set is rebuilt on
    /// the next successful start.
    pub async fn load(db: Arc<Db>) -> Self {
        let ips = DashSet::new();
        match db.all_bans().await {
            Ok(entries) => {
                for entry in entries {
                    match entry.parse::<IpAddr>() {
                        Ok(ip) => {
                            ips.insert(ip);
                        }
                        Err(_) => tracing::warn!(entry = %entry, "skipping invalid banned ip"),
                    }
                }
                tracing::info!(count = ips.len(), "bans loaded");
            }
            Err(e) => tracing::error!(error = %e, "failed to load bans, starting empty"),
        }
        Self { ips, db }
    }

    pub fn is_banned(&self, ip: IpAddr) -> bool {
        self.ips.contains(&ip)
    }

    /// Ban an IP: update the live set + write through to the db. Returns whether the set changed.
    pub fn ban(&self, ip: IpAddr) -> bool {
        let added = self.ips.insert(ip);
        if added {
            self.persist(ip, true);
            tracing::info!(%ip, "ip banned");
        }
        added
    }

    /// Unban an IP: update the live set + write through to the db. Returns whether the set changed.
    pub fn unban(&self, ip: IpAddr) -> bool {
        let removed = self.ips.remove(&ip).is_some();
        if removed {
            self.persist(ip, false);
            tracing::info!(%ip, "ip unbanned");
        }
        removed
    }

    /// Sorted list of banned IPs as strings.
    pub fn list(&self) -> Vec<String> {
        let sorted: BTreeSet<IpAddr> = self.ips.iter().map(|e| *e).collect();
        sorted.iter().map(|ip| ip.to_string()).collect()
    }

    /// Persist a ban change off the hot path; the in-memory set is already updated.
    fn persist(&self, ip: IpAddr, banned: bool) {
        let db = self.db.clone();
        let ip = ip.to_string();
        tokio::spawn(async move {
            let result = if banned {
                db.add_ban(&ip).await
            } else {
                db.remove_ban(&ip).await
            };
            if let Err(e) = result {
                tracing::error!(error = %e, "failed to persist ban change");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    async fn empty_bans() -> Bans {
        Bans::load(Arc::new(Db::memory().await)).await
    }

    #[tokio::test]
    async fn ban_unban_and_contains() {
        let bans = empty_bans().await;
        let ip = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
        assert!(!bans.is_banned(ip));
        assert!(bans.ban(ip));
        assert!(bans.is_banned(ip));
        assert!(!bans.ban(ip), "second ban is a no-op");
        assert!(bans.unban(ip));
        assert!(!bans.is_banned(ip));
        assert!(!bans.unban(ip), "second unban is a no-op");
    }

    #[tokio::test]
    async fn list_is_sorted() {
        let bans = empty_bans().await;
        bans.ban(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)));
        bans.ban(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)));
        bans.ban(IpAddr::V6(Ipv6Addr::LOCALHOST));
        assert_eq!(bans.list(), vec!["10.0.0.1", "10.0.0.2", "::1"]);
    }

    #[tokio::test]
    async fn warms_from_the_db_on_load() {
        let db = Arc::new(Db::memory().await);
        db.add_ban("203.0.113.7").await.unwrap();
        let bans = Bans::load(db).await;
        assert!(bans.is_banned(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7))));
        assert_eq!(bans.list(), vec!["203.0.113.7"]);
    }
}
