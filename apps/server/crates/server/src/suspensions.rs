//! Per-tenant world suspension. A thread-safe set of suspended tenant ids backed by a JSON file
//! (path from `SUSPENSIONS_FILE`, default `./data/suspensions.json`). Persists on every change so a
//! restart keeps a world suspended ("indefinitely" until an admin resumes it). Lookups are lock-free.

use std::path::PathBuf;

use dashmap::DashSet;

fn suspensions_path() -> PathBuf {
    std::env::var("SUSPENSIONS_FILE")
        .unwrap_or_else(|_| "./data/suspensions.json".into())
        .into()
}

pub struct Suspensions {
    tenants: DashSet<String>,
}

impl Suspensions {
    /// Load the persisted set. A missing or unreadable file starts empty.
    pub fn load() -> Self {
        let path = suspensions_path();
        let tenants = DashSet::new();
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Vec<String>>(&text) {
                Ok(entries) => {
                    for entry in entries {
                        tenants.insert(entry);
                    }
                    tracing::info!(count = tenants.len(), "suspensions loaded");
                }
                Err(e) => {
                    tracing::error!(path = %path.display(), error = %e, "invalid suspensions file, starting empty")
                }
            },
            Err(_) => tracing::info!(path = %path.display(), "no suspensions file, starting empty"),
        }
        Self { tenants }
    }

    pub fn is_suspended(&self, tenant: &str) -> bool {
        self.tenants.contains(tenant)
    }

    /// Suspend or resume a tenant and persist. Returns whether the set changed.
    pub fn set(&self, tenant: &str, suspended: bool) -> bool {
        let changed = if suspended {
            self.tenants.insert(tenant.to_string())
        } else {
            self.tenants.remove(tenant).is_some()
        };
        if changed {
            self.persist();
            tracing::info!(%tenant, suspended, "world suspension changed");
        }
        changed
    }

    fn persist(&self) {
        let entries: Vec<String> = self.tenants.iter().map(|t| t.clone()).collect();
        let path = suspensions_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string(&entries) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    tracing::error!(path = %path.display(), error = %e, "failed to persist suspensions");
                }
            }
            Err(e) => tracing::error!(error = %e, "failed to serialize suspensions"),
        }
    }
}
