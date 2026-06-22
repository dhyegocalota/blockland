//! Global IP ban list. A thread-safe map of banned `IpAddr` to the name they were banned under, warmed
//! from libSQL on startup and written through to it on every ban/unban, so a restart restores the list.
//! Lookups are lock-free on the hot path via `DashMap`; the database is the durable source of truth.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::Arc;

use dashmap::DashMap;

use crate::db::Db;

pub struct Bans {
    // ip -> the banned player's name, so admins unban by name. Bans restored from the db on restart have
    // no stored name (the db keeps only the ip), so they fall back to showing the ip.
    ips: DashMap<IpAddr, String>,
    db: Arc<Db>,
}

impl Bans {
    /// Warm the in-memory set from the db. A db error starts empty and is logged; the set is rebuilt on
    /// the next successful start.
    pub async fn load(db: Arc<Db>) -> Self {
        let ips = DashMap::new();
        match db.all_bans().await {
            Ok(entries) => {
                for entry in entries {
                    match entry.parse::<IpAddr>() {
                        Ok(ip) => {
                            ips.insert(ip, entry);
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
        self.ips.contains_key(&ip)
    }

    /// Ban an IP under a display name: update the live map + write through to the db. Returns whether
    /// the set changed.
    pub fn ban(&self, ip: IpAddr, name: String) -> bool {
        let added = self.ips.insert(ip, name).is_none();
        if added {
            self.persist(ip, true);
            tracing::info!(%ip, "ip banned");
        }
        added
    }

    /// Unban an IP: update the live map + write through to the db. Returns whether the set changed.
    pub fn unban(&self, ip: IpAddr) -> bool {
        let removed = self.ips.remove(&ip).is_some();
        if removed {
            self.persist(ip, false);
            tracing::info!(%ip, "ip unbanned");
        }
        removed
    }

    /// Sorted banned IPs as strings (the /admin dashboard's flat list).
    pub fn list(&self) -> Vec<String> {
        let sorted: BTreeMap<IpAddr, String> = self
            .ips
            .iter()
            .map(|e| (*e.key(), e.value().clone()))
            .collect();
        sorted.into_keys().map(|ip| ip.to_string()).collect()
    }

    /// Sorted banned (ip, name) pairs for the in-game admin unban list.
    pub fn list_named(&self) -> Vec<(String, String)> {
        let sorted: BTreeMap<IpAddr, String> = self
            .ips
            .iter()
            .map(|e| (*e.key(), e.value().clone()))
            .collect();
        sorted
            .into_iter()
            .map(|(ip, name)| (ip.to_string(), name))
            .collect()
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
        assert!(bans.ban(ip, "Mallory".into()));
        assert!(bans.is_banned(ip));
        assert!(!bans.ban(ip, "Mallory".into()), "second ban is a no-op");
        assert!(bans.unban(ip));
        assert!(!bans.is_banned(ip));
        assert!(!bans.unban(ip), "second unban is a no-op");
    }

    #[tokio::test]
    async fn list_is_sorted() {
        let bans = empty_bans().await;
        bans.ban(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)), "Bob".into());
        bans.ban(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), "Ann".into());
        bans.ban(IpAddr::V6(Ipv6Addr::LOCALHOST), "Cy".into());
        assert_eq!(bans.list(), vec!["10.0.0.1", "10.0.0.2", "::1"]);
        assert_eq!(
            bans.list_named(),
            vec![
                ("10.0.0.1".into(), "Ann".into()),
                ("10.0.0.2".into(), "Bob".into()),
                ("::1".into(), "Cy".into()),
            ]
        );
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
