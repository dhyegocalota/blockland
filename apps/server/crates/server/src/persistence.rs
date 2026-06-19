//! Per-tenant world persistence. Each tenant has a single world stored as one compressed
//! blob (see `sim::encode_edits`). Writes are tiny and only happen when the world changed.

use std::path::PathBuf;

fn world_dir() -> PathBuf {
    std::env::var("WORLD_DIR").unwrap_or_else(|_| "./data/worlds".into()).into()
}

fn blob_path(tenant: &str) -> PathBuf {
    // tenant ids are validated elsewhere (a-z0-9-), so they are safe as file names.
    let mut path = world_dir();
    path.push(format!("{tenant}.bin"));
    path
}

/// Read a tenant's stored world blob, if any.
pub fn load(tenant: &str) -> Option<Vec<u8>> {
    std::fs::read(blob_path(tenant)).ok()
}

/// Write a tenant's world blob, creating the directory if needed.
pub fn save(tenant: &str, blob: &[u8]) -> std::io::Result<()> {
    let path = blob_path(tenant);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, blob)
}

/// Delete a tenant's stored world (a reset). Missing file is treated as success.
pub fn reset(tenant: &str) {
    let _ = std::fs::remove_file(blob_path(tenant));
}
