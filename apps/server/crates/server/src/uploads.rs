//! Signed tenant-asset upload endpoint. Treats the body as hostile: content-type allowlist,
//! 2 MB cap (enforced both here and by `DefaultBodyLimit` on the route), and a strict
//! tenant-scoped key shape that forbids path traversal. The HMAC signature covers the query
//! (key + content_type) and the body hash, so all of it is authenticated.

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::{verify_internal, AppState};

pub const MAX_UPLOAD_BYTES: usize = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

#[derive(Deserialize)]
pub struct UploadParams {
    pub key: String,
    pub content_type: String,
}

/// Why an upload was rejected, with the HTTP status it maps to. `None` means the request is valid.
fn validate(params: &UploadParams, body_len: usize) -> Option<(StatusCode, &'static str)> {
    if !ALLOWED_CONTENT_TYPES.contains(&params.content_type.as_str()) {
        return Some((StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type"));
    }
    if body_len > MAX_UPLOAD_BYTES {
        return Some((StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"));
    }
    if !is_valid_key(&params.key) {
        return Some((StatusCode::BAD_REQUEST, "invalid_key"));
    }
    None
}

/// Key must be `tenants/<tenant>/<file>` with a restricted charset, blocking `..` and any
/// path traversal or absolute paths.
fn is_valid_key(key: &str) -> bool {
    let mut segments = key.split('/');
    let Some(prefix) = segments.next() else {
        return false;
    };
    let Some(tenant) = segments.next() else {
        return false;
    };
    let Some(file) = segments.next() else {
        return false;
    };
    if segments.next().is_some() {
        return false;
    }
    if prefix != "tenants" {
        return false;
    }
    is_slug(tenant) && is_filename(file)
}

fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_filename(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
        })
}

pub async fn internal_upload(
    State(state): State<AppState>,
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    Query(params): Query<UploadParams>,
    body: Bytes,
) -> Response {
    if let Some(resp) = verify_internal(&state.auth, "POST", &original_uri.0, &headers, &body) {
        return resp;
    }
    if let Some((status, message)) = validate(&params, body.len()) {
        return (status, message).into_response();
    }
    match state
        .storage
        .put(&params.key, &params.content_type, body.to_vec())
        .await
    {
        Ok(()) => Json(serde_json::json!({ "url": state.storage.public_url(&params.key) }))
            .into_response(),
        Err(error) => {
            tracing::error!(error = %error, "upload storage error");
            (StatusCode::INTERNAL_SERVER_ERROR, "storage_error").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(key: &str, content_type: &str) -> UploadParams {
        UploadParams {
            key: key.into(),
            content_type: content_type.into(),
        }
    }

    #[test]
    fn allows_supported_image_types() {
        for content_type in ["image/png", "image/jpeg", "image/webp"] {
            assert!(validate(&params("tenants/acme/avatar.png", content_type), 10).is_none());
        }
    }

    #[test]
    fn rejects_unsupported_content_type() {
        let rejection = validate(&params("tenants/acme/avatar.png", "image/gif"), 10);
        assert_eq!(
            rejection,
            Some((StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type"))
        );
    }

    #[test]
    fn rejects_oversize_body() {
        let rejection = validate(
            &params("tenants/acme/avatar.png", "image/png"),
            MAX_UPLOAD_BYTES + 1,
        );
        assert_eq!(
            rejection,
            Some((StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"))
        );
    }

    #[test]
    fn accepts_max_size_body() {
        assert!(validate(
            &params("tenants/acme/avatar.png", "image/png"),
            MAX_UPLOAD_BYTES
        )
        .is_none());
    }

    #[test]
    fn accepts_well_formed_keys() {
        assert!(is_valid_key("tenants/acme/avatar.png"));
        assert!(is_valid_key("tenants/acme-2/face_texture-1.webp"));
    }

    #[test]
    fn rejects_traversal_and_malformed_keys() {
        assert!(!is_valid_key("tenants/acme/../secret.png"));
        assert!(!is_valid_key("tenants/../etc/passwd"));
        assert!(!is_valid_key("/tenants/acme/avatar.png"));
        assert!(!is_valid_key("tenants/acme/sub/avatar.png"));
        assert!(!is_valid_key("other/acme/avatar.png"));
        assert!(!is_valid_key("tenants/Acme/avatar.png"));
        assert!(!is_valid_key("tenants/acme/"));
        assert!(!is_valid_key("tenants//avatar.png"));
        assert!(!is_valid_key("tenants/acme"));
    }
}
