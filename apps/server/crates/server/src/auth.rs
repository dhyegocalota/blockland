//! Per-tenant account identity. An account is a stable `account_id`; the username is its mutable
//! display name, owned by one email within a tenant and proven by a magic link (clickable token) or
//! a typed 6-digit code. A "claim" token is the single live session for an account; re-claiming kicks
//! the previous holder. A logged-in account can rename without re-emailing. This module is the pure
//! backend the HMAC-signed `/internal/auth/*` routes call into; emailing the token/code is Next's job.

use rand::Rng;

use crate::db::Db;
use crate::hub::{Claims, Hub};
use crate::room_io::RoomCmd;

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
    /// Email-only login for an address that has no account yet — the client must collect a name.
    Unknown,
}

/// The active session handed back after a magic link is verified.
pub struct Verified {
    pub tenant: String,
    pub name: String,
    pub claim: String,
    pub is_admin: bool,
    pub is_moderator: bool,
}

/// Outcome of a rename request, mapped 1:1 onto the HTTP contract.
pub enum RenameResult {
    Ok { name: String },
    NameTaken,
    Invalid,
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
    if let Some(account) = db.get_account_by_name(tenant, &name).await? {
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

/// Begin a login from an EMAIL alone (no name typed): look the account up by email and reuse its
/// current name. Returns `Unknown` when the email has no account yet (the client then asks for a name
/// and falls back to the name+email flow). Lets returning players log in with just their email.
pub async fn request_by_email(
    db: &Db,
    tenant: &str,
    email: &str,
) -> Result<RequestResult, libsql::Error> {
    let Some(email) = valid_email(email) else {
        return Ok(RequestResult::Invalid);
    };
    let Some(account) = db.get_account_by_email(tenant, &email).await? else {
        return Ok(RequestResult::Unknown);
    };
    let token = gen_token();
    let code = gen_code();
    db.create_magic_link(
        &token,
        &code,
        tenant,
        &account.name,
        &email,
        MAGIC_LINK_TTL_MS,
    )
    .await?;
    Ok(RequestResult::Ok {
        token,
        code,
        name: account.name,
        email,
    })
}

/// Finish a login: consume the magic link (single-use), find-or-create the account by
/// `(tenant, email)` and adopt the requested name if free (recording a `rename` timeline event when
/// the name changes), then mint a claim, persist it and publish it to the in-memory map keyed by the
/// stable account_id. This revokes the previous claim for that account.
pub async fn verify(
    db: &Db,
    claims: &Claims,
    by_token: Option<&str>,
    by_code: Option<(&str, &str, &str)>,
) -> Result<Option<Verified>, libsql::Error> {
    let Some(link) = db.consume_magic_link(by_token, by_code).await? else {
        return Ok(None);
    };
    let claimed = db
        .claim_account(&link.tenant, &link.email, &link.name)
        .await?;
    if claimed.renamed {
        db.record_event(
            &link.tenant,
            &claimed.account_id,
            "rename",
            &claimed.name,
            &claimed.old_name,
        )
        .await?;
    }
    let claim = gen_token();
    db.set_claim(&claimed.account_id, &claim).await?;
    claims.set(&claimed.account_id, &claim);
    Ok(Some(Verified {
        tenant: link.tenant,
        name: claimed.name,
        claim,
        is_admin: claimed.is_admin,
        is_moderator: claimed.is_moderator,
    }))
}

/// End a session: resolve the claim token to its account, then drop the persisted claim and forget
/// it in memory, but only if `claim` is the one currently held (a stale token must not log out a
/// re-claimed session).
pub async fn logout(
    db: &Db,
    claims: &Claims,
    tenant: &str,
    claim: &str,
) -> Result<(), libsql::Error> {
    let Some((account_id, _)) = db.claim_to_account(tenant, claim).await? else {
        return Ok(());
    };
    db.clear_claim(&account_id, claim).await?;
    claims.remove(&account_id, claim);
    Ok(())
}

/// Rename a logged-in account without re-emailing: validate the claim, then adopt `new_name` if it is
/// free in the tenant. On success, record a `rename` timeline event and notify the tenant's live room
/// so the player's name and a broadcast `Event` reflect the change.
pub async fn rename(
    hub: &Hub,
    tenant: &str,
    claim: &str,
    new_name: &str,
) -> Result<RenameResult, libsql::Error> {
    let Some(new_name) = valid_name(new_name) else {
        return Ok(RenameResult::Invalid);
    };
    let Some((account_id, _)) = hub.db.claim_to_account(tenant, claim).await? else {
        return Ok(RenameResult::Invalid);
    };
    let Some(old_name) = hub.db.rename_account(&account_id, &new_name).await? else {
        return Ok(RenameResult::NameTaken);
    };
    if old_name == new_name {
        return Ok(RenameResult::Ok { name: new_name });
    }
    hub.db
        .record_event(tenant, &account_id, "rename", &new_name, &old_name)
        .await?;
    hub.send_to_room(
        tenant,
        RoomCmd::Rename {
            account_id,
            new_name: new_name.clone(),
            old_name,
        },
    )
    .await;
    Ok(RenameResult::Ok { name: new_name })
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
            request(&db, "acme", "  ", "a@b.com").await.unwrap(),
            RequestResult::Invalid
        ));
        assert!(matches!(
            request(&db, "acme", "Ann", "bad-email").await.unwrap(),
            RequestResult::Invalid
        ));
    }

    async fn account_id(db: &Db, tenant: &str, name: &str) -> String {
        db.get_account_by_name(tenant, name)
            .await
            .unwrap()
            .unwrap()
            .account_id
    }

    #[tokio::test]
    async fn verify_by_code_mints_claim_and_persists_account() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (_token, code) = ok_request(&db, "acme", "Ann", "ann@x.com").await;

        let verified = verify(&db, &claims, None, Some(("acme", "Ann", &code)))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(verified.tenant, "acme");
        assert_eq!(verified.name, "Ann");
        assert_eq!(verified.claim.len(), TOKEN_HEX_CHARS);
        let id = account_id(&db, "acme", "Ann").await;
        assert_eq!(claims.get(&id).as_deref(), Some(verified.claim.as_str()));
        assert_eq!(
            db.get_account_by_name("acme", "Ann")
                .await
                .unwrap()
                .unwrap()
                .email,
            "ann@x.com"
        );
    }

    #[tokio::test]
    async fn verify_renames_a_returning_email_and_logs_the_event() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (first, _) = ok_request(&db, "acme", "Ann", "ann@x.com").await;
        verify(&db, &claims, Some(&first), None)
            .await
            .unwrap()
            .unwrap();
        // Same email comes back asking for a free name -> renamed, and the timeline records it.
        let (second, _) = ok_request(&db, "acme", "Annie", "ann@x.com").await;
        let verified = verify(&db, &claims, Some(&second), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(verified.name, "Annie");
        let events = db.recent_events("acme", 20).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "rename");
        assert_eq!(events[0].name, "Annie");
        assert_eq!(events[0].detail, "Ann");
    }

    #[tokio::test]
    async fn request_refuses_a_name_owned_by_another_email() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (token, _code) = ok_request(&db, "acme", "Ann", "ann@x.com").await;
        verify(&db, &claims, Some(&token), None)
            .await
            .unwrap()
            .unwrap();

        assert!(matches!(
            request(&db, "acme", "Ann", "mallory@x.com").await.unwrap(),
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
        let (first, _) = ok_request(&db, "acme", "Ann", "ann@x.com").await;
        let first_claim = verify(&db, &claims, Some(&first), None)
            .await
            .unwrap()
            .unwrap()
            .claim;
        let (second, _) = ok_request(&db, "acme", "Ann", "ann@x.com").await;
        let second_claim = verify(&db, &claims, Some(&second), None)
            .await
            .unwrap()
            .unwrap()
            .claim;

        assert_ne!(first_claim, second_claim);
        let id = account_id(&db, "acme", "Ann").await;
        assert_eq!(claims.get(&id).as_deref(), Some(second_claim.as_str()));
    }

    #[tokio::test]
    async fn logout_only_clears_the_matching_claim() {
        let db = Db::memory().await;
        let claims = Claims::default();
        let (token, _) = ok_request(&db, "acme", "Ann", "ann@x.com").await;
        let claim = verify(&db, &claims, Some(&token), None)
            .await
            .unwrap()
            .unwrap()
            .claim;
        let id = account_id(&db, "acme", "Ann").await;

        // A stale token resolves to no account and never clears the live claim.
        logout(&db, &claims, "acme", "stale-token").await.unwrap();
        assert_eq!(claims.get(&id).as_deref(), Some(claim.as_str()));

        logout(&db, &claims, "acme", &claim).await.unwrap();
        assert!(claims.get(&id).is_none());
    }

    #[tokio::test]
    async fn rename_updates_name_logs_event_and_guards_taken_or_invalid() {
        let db = std::sync::Arc::new(Db::memory().await);
        let hub = Hub::load(db).await;
        let (token, _) = ok_request(&hub.db, "acme", "Ann", "ann@x.com").await;
        let claim = verify(&hub.db, &hub.claims, Some(&token), None)
            .await
            .unwrap()
            .unwrap()
            .claim;

        // A free name renames the account and records a timeline event.
        let renamed = rename(&hub, "acme", &claim, "Annie").await.unwrap();
        assert!(matches!(renamed, RenameResult::Ok { name } if name == "Annie"));
        let account = hub
            .db
            .claim_to_account("acme", &claim)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(account.1, "Annie");
        let events = hub.db.recent_events("acme", 20).await.unwrap();
        assert_eq!(events.last().unwrap().name, "Annie");
        assert_eq!(events.last().unwrap().detail, "Ann");

        // A name already taken in the tenant is refused; the current name stays.
        let (bob_token, _) = ok_request(&hub.db, "acme", "Bob", "bob@x.com").await;
        verify(&hub.db, &hub.claims, Some(&bob_token), None)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            rename(&hub, "acme", &claim, "Bob").await.unwrap(),
            RenameResult::NameTaken
        ));

        // An unknown claim cannot rename anything.
        assert!(matches!(
            rename(&hub, "acme", "stale-token", "Zed").await.unwrap(),
            RenameResult::Invalid
        ));
        // An empty/over-long name is invalid.
        assert!(matches!(
            rename(&hub, "acme", &claim, "  ").await.unwrap(),
            RenameResult::Invalid
        ));
    }
}
