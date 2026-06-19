//! Per-tenant username identity. A username is owned by one email within a tenant; ownership is
//! proven by a magic link (clickable token) or a typed 6-digit code. A "claim" token is the single
//! live session for (tenant, name); re-claiming kicks the previous holder. This module is the pure
//! backend the HMAC-signed `/internal/auth/*` routes call into; emailing the token/code is Next's job.

use rand::Rng;

use crate::db::Db;
use crate::hub::Claims;

const TOKEN_HEX_CHARS: usize = 32;
const CODE_DIGITS: usize = 6;
const MAGIC_LINK_TTL_MS: i64 = 15 * 60 * 1000;
const NAME_MAX_LENGTH: usize = 16;
const EMAIL_MAX_LENGTH: usize = 254;

/// Outcome of a login request, mapped 1:1 onto the HTTP contract.
pub enum RequestResult {
    Ok {
        token: String,
        code: String,
        name: String,
        email: String,
    },
    NotOwner,
    Invalid,
}

/// The active session handed back after a magic link is verified.
pub struct Verified {
    pub tenant: String,
    pub name: String,
    pub claim: String,
}

/// Begin a login: validate the name + email, refuse if the name is already owned by a different
/// email, otherwise mint a token + code and store the magic link for 15 minutes.
pub async fn request(
    db: &Db,
    tenant: &str,
    name: &str,
    email: &str,
) -> Result<RequestResult, libsql::Error> {
    let Some(name) = valid_name(name) else {
        return Ok(RequestResult::Invalid);
    };
    let Some(email) = valid_email(email) else {
        return Ok(RequestResult::Invalid);
    };
    if let Some(account) = db.get_account(tenant, &name).await? {
        if account.email != email {
            return Ok(RequestResult::NotOwner);
        }
    }
    let token = gen_token();
    let code = gen_code();
    db.create_magic_link(&token, &code, tenant, &name, &email, MAGIC_LINK_TTL_MS)
        .await?;
    Ok(RequestResult::Ok {
        token,
        code,
        name,
        email,
    })
}

/// Finish a login: consume the magic link (single-use), upsert the account, mint a claim, persist
/// it and publish it to the in-memory map. This revokes the previous claim for that (tenant, name).
pub async fn verify(
    db: &Db,
    claims: &Claims,
    by_token: Option<&str>,
    by_code: Option<(&str, &str, &str)>,
) -> Result<Option<Verified>, libsql::Error> {
    let Some(link) = db.consume_magic_link(by_token, by_code).await? else {
        return Ok(None);
    };
    db.upsert_account(&link.tenant, &link.name, &link.email)
        .await?;
    let claim = gen_token();
    db.set_claim(&link.tenant, &link.name, &link.email, &claim)
        .await?;
    claims.set(&link.tenant, &link.name, &claim);
    Ok(Some(Verified {
        tenant: link.tenant,
        name: link.name,
        claim,
    }))
}

/// End a session: drop the persisted claim and forget it in memory, but only if `claim` is the one
/// currently held (a stale token must not log out a re-claimed session).
pub async fn logout(
    db: &Db,
    claims: &Claims,
    tenant: &str,
    name: &str,
    claim: &str,
) -> Result<(), libsql::Error> {
    db.clear_claim(tenant, name, claim).await?;
    claims.remove(tenant, name, claim);
    Ok(())
}

fn valid_name(raw: &str) -> Option<String> {
    let name = raw.trim().to_string();
    if name.is_empty() || name.chars().count() > NAME_MAX_LENGTH {
        return None;
    }
    Some(name)
}

/// A deliberately simple shape check (not RFC 5322): one `@` with text on both sides and a dot in
/// the domain after the `@`. The real proof of ownership is delivery of the magic link.
fn valid_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_string();
    if email.len() > EMAIL_MAX_LENGTH {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    let dot = domain.find('.')?;
    if dot + 1 >= domain.len() {
        return None;
    }
    Some(email)
}

fn gen_token() -> String {
    let mut rng = rand::thread_rng();
    (0..TOKEN_HEX_CHARS)
        .map(|_| std::char::from_digit(rng.gen_range(0u32..16), 16).expect("0..16 is a hex digit"))
        .collect()
}

fn gen_code() -> String {
    let mut rng = rand::thread_rng();
    (0..CODE_DIGITS)
        .map(|_| std::char::from_digit(rng.gen_range(0u32..10), 10).expect("0..10 is a digit"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_lowercase_hex() {
        let token = gen_token();
        assert_eq!(token.len(), TOKEN_HEX_CHARS);
        assert!(token
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn code_is_6_ascii_digits() {
        let code = gen_code();
        assert_eq!(code.len(), CODE_DIGITS);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn valid_email_accepts_well_formed() {
        assert!(valid_email("maria@example.com").is_some());
        assert!(valid_email("  a.b@sub.domain.io  ").is_some());
    }

    #[test]
    fn valid_email_rejects_malformed() {
        assert!(valid_email("no-at-sign").is_none());
        assert!(valid_email("@example.com").is_none());
        assert!(valid_email("maria@").is_none());
        assert!(valid_email("maria@nodot").is_none());
        assert!(valid_email("maria@ends.").is_none());
        assert!(valid_email(&format!("{}@example.com", "x".repeat(EMAIL_MAX_LENGTH))).is_none());
    }

    #[test]
    fn valid_name_trims_and_caps_length() {
        assert_eq!(valid_name("  Ann  ").as_deref(), Some("Ann"));
        assert!(valid_name("").is_none());
        assert!(valid_name("   ").is_none());
        assert!(valid_name(&"a".repeat(NAME_MAX_LENGTH + 1)).is_none());
    }

    async fn ok_request(db: &Db, tenant: &str, name: &str, email: &str) -> (String, String) {
        match request(db, tenant, name, email).await.unwrap() {
            RequestResult::Ok { token, code, .. } => (token, code),
            _ => panic!("expected RequestResult::Ok"),
        }
    }

    #[tokio::test]
    async fn request_rejects_invalid_name_or_email() {
        let db = Db::memory().await;
        assert!(matches!(
            request(&db, "teo", "  ", "a@b.com").await.unwrap(),
            RequestResult::Invalid
        ));
        assert!(matches!(
            request(&db, "teo", "Ann", "bad-email").await.unwrap(),
            RequestResult::Invalid
        ));
    }

    #[tokio::test]
    async fn verify_by_code_mints_claim_and_persists_account() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (_token, code) = ok_request(&db, "teo", "Ann", "ann@x.com").await;

        let verified = verify(&db, &claims, None, Some(("teo", "Ann", &code)))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(verified.tenant, "teo");
        assert_eq!(verified.name, "Ann");
        assert_eq!(verified.claim.len(), TOKEN_HEX_CHARS);
        assert_eq!(
            claims.get("teo", "Ann").as_deref(),
            Some(verified.claim.as_str())
        );
        assert_eq!(
            db.get_account("teo", "Ann").await.unwrap().unwrap().email,
            "ann@x.com"
        );
    }

    #[tokio::test]
    async fn request_refuses_a_name_owned_by_another_email() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (token, _code) = ok_request(&db, "teo", "Ann", "ann@x.com").await;
        verify(&db, &claims, Some(&token), None)
            .await
            .unwrap()
            .unwrap();

        assert!(matches!(
            request(&db, "teo", "Ann", "mallory@x.com").await.unwrap(),
            RequestResult::NotOwner
        ));
        // The same name in another tenant is a different, unowned account.
        assert!(matches!(
            request(&db, "demo", "Ann", "mallory@x.com").await.unwrap(),
            RequestResult::Ok { .. }
        ));
    }

    #[tokio::test]
    async fn reclaim_replaces_the_live_claim() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (first, _) = ok_request(&db, "teo", "Ann", "ann@x.com").await;
        let first_claim = verify(&db, &claims, Some(&first), None)
            .await
            .unwrap()
            .unwrap()
            .claim;
        let (second, _) = ok_request(&db, "teo", "Ann", "ann@x.com").await;
        let second_claim = verify(&db, &claims, Some(&second), None)
            .await
            .unwrap()
            .unwrap()
            .claim;

        assert_ne!(first_claim, second_claim);
        assert_eq!(
            claims.get("teo", "Ann").as_deref(),
            Some(second_claim.as_str())
        );
    }

    #[tokio::test]
    async fn logout_only_clears_the_matching_claim() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (token, _) = ok_request(&db, "teo", "Ann", "ann@x.com").await;
        let claim = verify(&db, &claims, Some(&token), None)
            .await
            .unwrap()
            .unwrap()
            .claim;

        logout(&db, &claims, "teo", "Ann", "stale-token")
            .await
            .unwrap();
        assert_eq!(claims.get("teo", "Ann").as_deref(), Some(claim.as_str()));

        logout(&db, &claims, "teo", "Ann", &claim).await.unwrap();
        assert!(claims.get("teo", "Ann").is_none());
    }
}
