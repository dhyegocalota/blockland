//! Internal request authentication for the Next -> Rust data channel. Both sides build the
//! same canonical string and sign it with HMAC-SHA256 over a shared secret. Requests carry
//! `x-bl-ts`, `x-bl-nonce`, `x-bl-sig`; we reject stale timestamps, replayed nonces, and any
//! signature mismatch (compared in constant time).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const MAX_CLOCK_SKEW_SECS: i64 = 30;
const NONCE_TTL_SECS: u64 = 60;

type HmacSha256 = Hmac<Sha256>;

/// Why a signed request was refused. Returned as `Err` so the handler maps it to a 401.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    BadTimestamp,
    StaleTimestamp,
    ReplayedNonce,
    BadSignature,
}

/// The three signing headers pulled off a request.
pub struct AuthHeaders<'a> {
    pub timestamp: &'a str,
    pub nonce: &'a str,
    pub signature: &'a str,
}

/// Holds the secret and the short-lived seen-nonce cache used to block replays.
pub struct InternalAuth {
    secret: Vec<u8>,
    seen_nonces: Mutex<HashMap<String, u64>>,
}

impl InternalAuth {
    pub fn from_env() -> Self {
        let secret = std::env::var("INTERNAL_HMAC_SECRET")
            .expect("INTERNAL_HMAC_SECRET must be set")
            .into_bytes();
        Self {
            secret,
            seen_nonces: Mutex::new(HashMap::new()),
        }
    }

    /// Verify a signed request. `path` includes the query string when present; `body` is the
    /// raw request bytes (empty for GET/DELETE).
    pub fn verify(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        headers: &AuthHeaders<'_>,
    ) -> Result<(), AuthError> {
        let timestamp: i64 = headers
            .timestamp
            .parse()
            .map_err(|_| AuthError::BadTimestamp)?;
        let now = unix_secs();
        if (now - timestamp).abs() > MAX_CLOCK_SKEW_SECS {
            return Err(AuthError::StaleTimestamp);
        }

        let canonical = canonical_string(method, path, headers.timestamp, headers.nonce, body);
        let expected = sign(&self.secret, &canonical);
        let provided = decode_hex(headers.signature).ok_or(AuthError::BadSignature)?;
        if !constant_time_eq(&expected, &provided) {
            return Err(AuthError::BadSignature);
        }

        self.remember_nonce(headers.nonce, now.max(0) as u64)
    }

    fn remember_nonce(&self, nonce: &str, now: u64) -> Result<(), AuthError> {
        let mut seen = self.seen_nonces.lock().expect("nonce cache poisoned");
        seen.retain(|_, &mut expires_at| expires_at > now);
        if seen.contains_key(nonce) {
            return Err(AuthError::ReplayedNonce);
        }
        seen.insert(nonce.to_string(), now + NONCE_TTL_SECS);
        Ok(())
    }
}

fn canonical_string(method: &str, path: &str, timestamp: &str, nonce: &str, body: &[u8]) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path,
        timestamp,
        nonce,
        sha256_hex(body)
    )
}

fn sign(secret: &[u8], canonical: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(canonical.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hex::encode(hasher.finalize())
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    hex::decode(value).ok()
}

fn unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Length-independent constant-time byte comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"bl-internal-test-secret";

    fn auth() -> InternalAuth {
        InternalAuth {
            secret: SECRET.to_vec(),
            seen_nonces: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn golden_vector_signature() {
        let body = br#"{"id":"x"}"#;
        assert_eq!(
            sha256_hex(body),
            "5e2b92cc57ce618dfbb54844a31775e4b95c6fb552ee6bf5a068133c12d2ad90"
        );
        let canonical = canonical_string(
            "POST",
            "/internal/tenants",
            "1700000000",
            "0123456789abcdef",
            body,
        );
        let signature = hex::encode(sign(SECRET, &canonical));
        assert_eq!(
            signature,
            "8400280bdd1590664580d3486483a3cf5d75a92f1e0534ea6f7a596e816051b2"
        );
    }

    fn sign_request(timestamp: &str, nonce: &str) -> String {
        let canonical = canonical_string(
            "POST",
            "/internal/tenants",
            timestamp,
            nonce,
            br#"{"id":"x"}"#,
        );
        hex::encode(sign(SECRET, &canonical))
    }

    #[test]
    fn accepts_fresh_signed_request() {
        let auth = auth();
        let timestamp = unix_secs().to_string();
        let signature = sign_request(&timestamp, "nonce-a");
        let result = auth.verify(
            "POST",
            "/internal/tenants",
            br#"{"id":"x"}"#,
            &AuthHeaders {
                timestamp: &timestamp,
                nonce: "nonce-a",
                signature: &signature,
            },
        );
        assert!(result.is_ok());
    }

    #[test]
    fn rejects_replayed_nonce() {
        let auth = auth();
        let timestamp = unix_secs().to_string();
        let signature = sign_request(&timestamp, "nonce-b");
        let headers = AuthHeaders {
            timestamp: &timestamp,
            nonce: "nonce-b",
            signature: &signature,
        };
        assert!(auth
            .verify("POST", "/internal/tenants", br#"{"id":"x"}"#, &headers)
            .is_ok());
        assert_eq!(
            auth.verify("POST", "/internal/tenants", br#"{"id":"x"}"#, &headers),
            Err(AuthError::ReplayedNonce)
        );
    }

    #[test]
    fn rejects_stale_timestamp() {
        let auth = auth();
        let timestamp = (unix_secs() - MAX_CLOCK_SKEW_SECS - 5).to_string();
        let signature = sign_request(&timestamp, "nonce-c");
        assert_eq!(
            auth.verify(
                "POST",
                "/internal/tenants",
                br#"{"id":"x"}"#,
                &AuthHeaders {
                    timestamp: &timestamp,
                    nonce: "nonce-c",
                    signature: &signature,
                },
            ),
            Err(AuthError::StaleTimestamp)
        );
    }

    #[test]
    fn rejects_bad_signature() {
        let auth = auth();
        let timestamp = unix_secs().to_string();
        assert_eq!(
            auth.verify(
                "POST",
                "/internal/tenants",
                br#"{"id":"x"}"#,
                &AuthHeaders {
                    timestamp: &timestamp,
                    nonce: "nonce-d",
                    signature: "deadbeef",
                },
            ),
            Err(AuthError::BadSignature)
        );
    }
}
