//! Global IP ban list. A thread-safe set of banned `IpAddr` backed by a JSON file
//! (path from `BANS_FILE`, default `./data/bans.json`). Persists on every ban/unban so a
//! restart restores the list. Lookups are lock-free on the hot path via `DashMap`.

use std::collections::BTreeSet;
use std::net::IpAddr;
use std::path::PathBuf;

use dashmap::DashSet;

fn bans_path() -> PathBuf {
    std::env::var("BANS_FILE")
        .unwrap_or_else(|_| "./data/bans.json".into())
        .into()
}

pub struct Bans {
    ips: DashSet<IpAddr>,
}

impl Bans {
    /// Load the persisted ban list. A missing or unreadable file starts empty.
    pub fn load() -> Self {
        let path = bans_path();
        let ips = DashSet::new();
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Vec<String>>(&text) {
                Ok(entries) => {
                    for entry in entries {
                        match entry.parse::<IpAddr>() {
                            Ok(ip) => {
                                ips.insert(ip);
                            }
                            Err(_) => {
                                tracing::warn!(entry = %entry, "skipping invalid banned ip")
                            }
                        }
                    }
                    tracing::info!(count = ips.len(), "bans loaded");
                }
                Err(e) => {
                    tracing::error!(path = %path.display(), error = %e, "invalid bans file, starting empty")
                }
            },
            Err(_) => tracing::info!(path = %path.display(), "no bans file, starting empty"),
        }
        Self { ips }
    }

    pub fn is_banned(&self, ip: IpAddr) -> bool {
        self.ips.contains(&ip)
    }

    /// Ban an IP and persist. Returns whether the set changed.
    pub fn ban(&self, ip: IpAddr) -> bool {
        let added = self.ips.insert(ip);
        if added {
            self.persist();
            tracing::info!(%ip, "ip banned");
        }
        added
    }

    /// Unban an IP and persist. Returns whether the set changed.
    pub fn unban(&self, ip: IpAddr) -> bool {
        let removed = self.ips.remove(&ip).is_some();
        if removed {
            self.persist();
            tracing::info!(%ip, "ip unbanned");
        }
        removed
    }

    /// Sorted list of banned IPs as strings.
    pub fn list(&self) -> Vec<String> {
        let sorted: BTreeSet<IpAddr> = self.ips.iter().map(|e| *e).collect();
        sorted.iter().map(|ip| ip.to_string()).collect()
    }

    fn persist(&self) {
        let path = bans_path();
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::error!(path = %path.display(), error = %e, "failed to create bans dir");
                return;
            }
        }
        let entries = self.list();
        match serde_json::to_string_pretty(&entries) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&path, text) {
                    tracing::error!(path = %path.display(), error = %e, "failed to write bans file");
                }
            }
            Err(e) => tracing::error!(error = %e, "failed to serialize bans"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::sync::Mutex;

    // Serialize tests: they share the process-global BANS_FILE env var.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn with_temp_bans_file(test: impl FnOnce(&PathBuf)) {
        let _lock = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let mut path = std::env::temp_dir();
        path.push(format!("bans-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("BANS_FILE", &path);
        test(&path);
        let _ = std::fs::remove_file(&path);
        std::env::remove_var("BANS_FILE");
    }

    #[test]
    fn ban_unban_and_contains() {
        with_temp_bans_file(|_| {
            let bans = Bans::load();
            let ip = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
            assert!(!bans.is_banned(ip));
            assert!(bans.ban(ip));
            assert!(bans.is_banned(ip));
            assert!(!bans.ban(ip), "second ban is a no-op");
            assert!(bans.unban(ip));
            assert!(!bans.is_banned(ip));
            assert!(!bans.unban(ip), "second unban is a no-op");
        });
    }

    #[test]
    fn list_is_sorted() {
        with_temp_bans_file(|_| {
            let bans = Bans::load();
            bans.ban(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2)));
            bans.ban(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)));
            bans.ban(IpAddr::V6(Ipv6Addr::LOCALHOST));
            assert_eq!(bans.list(), vec!["10.0.0.1", "10.0.0.2", "::1"]);
        });
    }

    #[test]
    fn list_round_trips_through_file() {
        with_temp_bans_file(|_| {
            let ip = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7));
            {
                let bans = Bans::load();
                bans.ban(ip);
            }
            let reloaded = Bans::load();
            assert!(reloaded.is_banned(ip));
            assert_eq!(reloaded.list(), vec!["203.0.113.7"]);
        });
    }
}
