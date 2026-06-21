//! Outbound notifications to the Next web app, which owns the mailer (Resend). When a player is held
//! out by the approval gate, the server posts the tenant's admin emails + the player's name to the
//! web's internal, HMAC-signed endpoint, which renders and sends the approval email. The signing
//! scheme matches `internal_auth` (the verify side) so the same shared secret authenticates both
//! directions. If `WEB_BASE_URL` is unset the call is skipped (in-game approval still works).

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::Db;

type HmacSha256 = Hmac<Sha256>;

const NOTIFY_PATH: &str = "/api/internal/approval-notify";

#[derive(Serialize)]
struct ApprovalNotice {
    tenant: String,
    name: String,
    emails: Vec<String>,
}

/// Email the tenant's admins that `name` is waiting for approval. Best-effort: every failure is logged
/// and swallowed so a held-out join never blocks on the mailer.
pub async fn approval_request(db: &Db, tenant: &str, name: &str) {
    let Ok(base_url) = std::env::var("WEB_BASE_URL") else {
        tracing::warn!(
            %tenant,
            "approval email skipped: WEB_BASE_URL unset (approve in-game instead)"
        );
        return;
    };
    let Ok(secret) = std::env::var("INTERNAL_HMAC_SECRET") else {
        tracing::warn!(%tenant, "approval email skipped: INTERNAL_HMAC_SECRET unset");
        return;
    };
    let emails = match db.tenant_admin_emails(tenant).await {
        Ok(found) => found,
        Err(e) => {
            tracing::error!(error = %e, "approval email: admin lookup failed");
            return;
        }
    };
    if emails.is_empty() {
        tracing::warn!(%tenant, "approval email skipped: tenant has no admins");
        return;
    }
    let payload = ApprovalNotice {
        tenant: tenant.to_string(),
        name: name.to_string(),
        emails,
    };
    let body = match serde_json::to_vec(&payload) {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::error!(error = %e, "approval email: serialize failed");
            return;
        }
    };
    let timestamp = unix_secs().to_string();
    let nonce = gen_nonce();
    let signature = sign(secret.as_bytes(), "POST", NOTIFY_PATH, &timestamp, &nonce, &body);
    let url = format!("{}{}", base_url.trim_end_matches('/'), NOTIFY_PATH);
    let result = reqwest::Client::new()
        .post(url)
        .header("content-type", "application/json")
        .header("x-bl-ts", timestamp)
        .header("x-bl-nonce", nonce)
        .header("x-bl-sig", signature)
        .body(body)
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {
            tracing::info!(%tenant, "approval email requested");
        }
        Ok(response) => {
            tracing::error!(%tenant, status = %response.status(), "approval email rejected by web");
        }
        Err(e) => tracing::error!(%tenant, error = %e, "approval email request failed"),
    }
}

fn sign(
    secret: &[u8],
    method: &str,
    path: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
) -> String {
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path,
        timestamp,
        nonce,
        sha256_hex(body)
    );
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn sha256_hex(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hex::encode(hasher.finalize())
}

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn gen_nonce() -> String {
    use rand::Rng;
    let bytes: [u8; 8] = rand::thread_rng().gen();
    hex::encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The signature must match `internal_auth`'s golden vector so the web verifies what we sign.
    #[test]
    fn signature_matches_internal_auth_golden_vector() {
        let body = br#"{"id":"x"}"#;
        let signature = sign(
            b"bl-internal-test-secret",
            "POST",
            "/internal/tenants",
            "1700000000",
            "0123456789abcdef",
            body,
        );
        assert_eq!(
            signature,
            "8400280bdd1590664580d3486483a3cf5d75a92f1e0534ea6f7a596e816051b2"
        );
    }
}
