//! Storage abstraction. The app talks only to the `Storage` trait; Cloudflare R2 is one
//! implementation behind it (`R2Storage`), `LocalStorage` is the dev/CI implementation that
//! writes to disk so tests never need a real bucket. Pick one with `from_env`.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use s3::creds::Credentials;
use s3::region::Region;
use s3::Bucket;

const DEFAULT_UPLOAD_DIR: &str = "./data/uploads";
const R2_REGION: &str = "auto";
const HTTP_OK: u16 = 200;

/// Why a storage operation failed. Mapped to a generic 500 by callers; internals never leak.
#[derive(Debug)]
pub enum StorageError {
    NotConfigured(String),
    Io(std::io::Error),
    Upstream(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::NotConfigured(field) => write!(f, "storage not configured: {field}"),
            StorageError::Io(error) => write!(f, "storage io error: {error}"),
            StorageError::Upstream(detail) => write!(f, "storage upstream error: {detail}"),
        }
    }
}

impl std::error::Error for StorageError {}

/// Dependency-inversion boundary for object storage. The app depends on this, never on R2.
#[async_trait]
pub trait Storage: Send + Sync {
    async fn put(&self, key: &str, content_type: &str, bytes: Vec<u8>) -> Result<(), StorageError>;
    #[allow(dead_code)]
    async fn delete(&self, key: &str) -> Result<(), StorageError>;
    fn public_url(&self, key: &str) -> String;
}

/// Build the configured backend from the environment. `STORAGE_BACKEND` selects `local`
/// (default) or `r2`.
pub fn from_env() -> Arc<dyn Storage> {
    let backend = std::env::var("STORAGE_BACKEND").unwrap_or_else(|_| "local".into());
    if backend == "r2" {
        return Arc::new(R2Storage::from_env().expect("configure R2Storage"));
    }
    Arc::new(LocalStorage::from_env())
}

/// Cloudflare R2 backed by rustls (no system OpenSSL). Uses a custom `auto` region pointed at
/// the R2 endpoint with path-style addressing, which R2 requires.
pub struct R2Storage {
    bucket: Box<Bucket>,
    public_base: String,
}

impl R2Storage {
    pub fn from_env() -> Result<Self, StorageError> {
        let access_key = required_env("R2_ACCESS_KEY_ID")?;
        let secret_key = required_env("R2_SECRET_ACCESS_KEY")?;
        let bucket_name = required_env("R2_BUCKET")?;
        let public_base = required_env("R2_PUBLIC_BASE")?;
        let endpoint = r2_endpoint()?;

        let credentials = Credentials::new(Some(&access_key), Some(&secret_key), None, None, None)
            .map_err(|error| StorageError::NotConfigured(error.to_string()))?;
        let region = Region::Custom {
            region: R2_REGION.into(),
            endpoint,
        };
        let bucket = Bucket::new(&bucket_name, region, credentials)
            .map_err(|error| StorageError::NotConfigured(error.to_string()))?
            .with_path_style();

        Ok(Self {
            bucket,
            public_base,
        })
    }
}

#[async_trait]
impl Storage for R2Storage {
    async fn put(&self, key: &str, content_type: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        let response = self
            .bucket
            .put_object_with_content_type(key, &bytes, content_type)
            .await
            .map_err(|error| StorageError::Upstream(error.to_string()))?;
        if response.status_code() != HTTP_OK {
            return Err(StorageError::Upstream(format!(
                "put status {}",
                response.status_code()
            )));
        }
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), StorageError> {
        self.bucket
            .delete_object(key)
            .await
            .map_err(|error| StorageError::Upstream(error.to_string()))?;
        Ok(())
    }

    fn public_url(&self, key: &str) -> String {
        join_url(&self.public_base, key)
    }
}

/// Filesystem backend for dev/CI. Writes under `root` and exposes files at
/// `<public_base>/uploads/<key>`.
pub struct LocalStorage {
    root: PathBuf,
    public_base: String,
}

impl LocalStorage {
    pub fn from_env() -> Self {
        let root = std::env::var("UPLOAD_DIR").unwrap_or_else(|_| DEFAULT_UPLOAD_DIR.into());
        let public_base = std::env::var("UPLOAD_PUBLIC_BASE").unwrap_or_default();
        Self {
            root: PathBuf::from(root),
            public_base,
        }
    }
}

#[async_trait]
impl Storage for LocalStorage {
    async fn put(
        &self,
        key: &str,
        _content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<(), StorageError> {
        let path = self.root.join(key);
        let Some(parent) = path.parent() else {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "key has no parent",
            )));
        };
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(StorageError::Io)?;
        tokio::fs::write(&path, bytes)
            .await
            .map_err(StorageError::Io)
    }

    async fn delete(&self, key: &str) -> Result<(), StorageError> {
        match tokio::fs::remove_file(self.root.join(key)).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(StorageError::Io(error)),
        }
    }

    fn public_url(&self, key: &str) -> String {
        join_url(&self.public_base, &format!("uploads/{key}"))
    }
}

fn required_env(name: &str) -> Result<String, StorageError> {
    std::env::var(name).map_err(|_| StorageError::NotConfigured(name.to_string()))
}

/// R2 endpoint comes from `R2_ENDPOINT` directly, or is derived from `R2_ACCOUNT_ID`.
fn r2_endpoint() -> Result<String, StorageError> {
    if let Ok(endpoint) = std::env::var("R2_ENDPOINT") {
        return Ok(endpoint);
    }
    let account_id = required_env("R2_ACCOUNT_ID")?;
    Ok(format!("https://{account_id}.r2.cloudflarestorage.com"))
}

fn join_url(base: &str, key: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        key.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FakeStorage {
        objects: Mutex<HashMap<String, (String, Vec<u8>)>>,
    }

    impl FakeStorage {
        fn new() -> Self {
            Self {
                objects: Mutex::new(HashMap::new()),
            }
        }
    }

    #[async_trait]
    impl Storage for FakeStorage {
        async fn put(
            &self,
            key: &str,
            content_type: &str,
            bytes: Vec<u8>,
        ) -> Result<(), StorageError> {
            self.objects
                .lock()
                .unwrap()
                .insert(key.to_string(), (content_type.to_string(), bytes));
            Ok(())
        }

        async fn delete(&self, key: &str) -> Result<(), StorageError> {
            self.objects.lock().unwrap().remove(key);
            Ok(())
        }

        fn public_url(&self, key: &str) -> String {
            format!("mem://{key}")
        }
    }

    #[tokio::test]
    async fn fake_storage_honors_put_delete_url_contract() {
        let storage = FakeStorage::new();
        let key = "tenants/acme/avatar.png";

        storage
            .put(key, "image/png", b"pixels".to_vec())
            .await
            .unwrap();
        {
            let objects = storage.objects.lock().unwrap();
            let (content_type, bytes) = objects.get(key).unwrap();
            assert_eq!(content_type, "image/png");
            assert_eq!(bytes, b"pixels");
        }
        assert_eq!(storage.public_url(key), "mem://tenants/acme/avatar.png");

        storage.delete(key).await.unwrap();
        assert!(storage.objects.lock().unwrap().get(key).is_none());
    }

    #[tokio::test]
    async fn local_storage_put_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let storage = LocalStorage {
            root: dir.path().to_path_buf(),
            public_base: "https://cdn.example".into(),
        };
        let key = "tenants/acme/face.png";

        storage
            .put(key, "image/png", b"face-bytes".to_vec())
            .await
            .unwrap();
        let written = tokio::fs::read(dir.path().join(key)).await.unwrap();
        assert_eq!(written, b"face-bytes");

        storage.delete(key).await.unwrap();
        assert!(tokio::fs::metadata(dir.path().join(key)).await.is_err());
    }

    #[test]
    fn local_storage_public_url_includes_uploads_prefix() {
        let storage = LocalStorage {
            root: PathBuf::from("/tmp"),
            public_base: "https://cdn.example/".into(),
        };
        assert_eq!(
            storage.public_url("tenants/acme/avatar.png"),
            "https://cdn.example/uploads/tenants/acme/avatar.png"
        );
    }

    #[test]
    fn join_url_collapses_slashes() {
        assert_eq!(join_url("https://b/", "/k"), "https://b/k");
        assert_eq!(join_url("https://b", "k"), "https://b/k");
    }
}
