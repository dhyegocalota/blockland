//! Per-tenant "require approval for new players" flag. A thread-safe set of tenant ids that require
//! approval, backed by a JSON file (path from `APPROVALS_FILE`, default `./data/approvals.json`).
//! Persists on every change so a restart keeps the gate on. Lookups are lock-free. Default is OFF:
//! a tenant only requires approval once an admin turns it on.

use std::path::PathBuf;

use dashmap::DashSet;

fn approvals_path() -> PathBuf {
    std::env::var("APPROVALS_FILE")
        .unwrap_or_else(|_| "./data/approvals.json".into())
        .into()
}

pub struct ApprovalGate {
    tenants: DashSet<String>,
}

impl ApprovalGate {
    /// Load the persisted set. A missing or unreadable file starts empty (approval off everywhere).
    pub fn load() -> Self {
        let path = approvals_path();
        let tenants = DashSet::new();
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Vec<String>>(&text) {
                Ok(entries) => {
                    for entry in entries {
                        tenants.insert(entry);
                    }
                    tracing::info!(count = tenants.len(), "approval gates loaded");
                }
                Err(e) => {
                    tracing::error!(path = %path.display(), error = %e, "invalid approvals file, starting empty")
                }
            },
            Err(_) => tracing::info!(path = %path.display(), "no approvals file, starting empty"),
        }
        Self { tenants }
    }

    pub fn is_required(&self, tenant: &str) -> bool {
        self.tenants.contains(tenant)
    }

    /// Turn the approval gate on or off for a tenant and persist. Returns whether the set changed.
    pub fn set(&self, tenant: &str, required: bool) -> bool {
        let changed = if required {
            self.tenants.insert(tenant.to_string())
        } else {
            self.tenants.remove(tenant).is_some()
        };
        if changed {
            self.persist();
            tracing::info!(%tenant, required, "approval gate changed");
        }
        changed
    }

    fn persist(&self) {
        let entries: Vec<String> = self.tenants.iter().map(|t| t.clone()).collect();
        let path = approvals_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string(&entries) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    tracing::error!(path = %path.display(), error = %e, "failed to persist approvals");
                }
            }
            Err(e) => tracing::error!(error = %e, "failed to serialize approvals"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_GUARD: Mutex<()> = Mutex::new(());

    fn with_temp_file(test: impl FnOnce()) {
        let _lock = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let mut path = std::env::temp_dir();
        path.push(format!("approvals-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("APPROVALS_FILE", &path);
        test();
        let _ = std::fs::remove_file(&path);
        std::env::remove_var("APPROVALS_FILE");
    }

    #[test]
    fn off_by_default_then_toggles() {
        with_temp_file(|| {
            let gate = ApprovalGate::load();
            assert!(!gate.is_required("teo"), "approval is off by default");
            assert!(gate.set("teo", true));
            assert!(gate.is_required("teo"));
            assert!(!gate.set("teo", true), "second enable is a no-op");
            assert!(gate.set("teo", false));
            assert!(!gate.is_required("teo"));
        });
    }

    #[test]
    fn round_trips_through_file() {
        with_temp_file(|| {
            {
                let gate = ApprovalGate::load();
                gate.set("teo", true);
            }
            let reloaded = ApprovalGate::load();
            assert!(reloaded.is_required("teo"));
        });
    }
}
