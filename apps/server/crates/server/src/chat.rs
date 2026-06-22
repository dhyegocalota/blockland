//! Lightweight chat moderation for a kids' room: drop a message that carries a link or a blocked word
//! before it is ever broadcast. Pure and synchronous so it is trivially testable; the room calls
//! `is_allowed` on the already-trimmed text. This is a safety floor for a children's product, not a
//! complete profanity engine.

// A small, case-insensitive blocklist (en-US + pt-BR). Matched on word boundaries so common words that
// merely contain a blocked substring (e.g. pt-BR "disputa" containing "puta") are not flagged.
const BLOCKED_WORDS: &[&str] = &[
    "fuck", "fucking", "shit", "bitch", "asshole", "bastard", "dick", "pussy", "cunt", "slut",
    "whore", "fag", "faggot", "nigger", "retard", "merda", "porra", "caralho", "puta", "buceta",
    "viado", "piranha", "corno", "foder", "cuzao",
];

/// Whether a chat message is safe to broadcast: it must carry no link and no blocked word.
pub fn is_allowed(text: &str) -> bool {
    let lower = text.to_lowercase();
    if contains_link(&lower) {
        return false;
    }
    !lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| BLOCKED_WORDS.contains(&token))
}

fn contains_link(lower: &str) -> bool {
    lower.contains("http://") || lower.contains("https://") || lower.contains("www.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_friendly_messages() {
        assert!(is_allowed("hi friends lets build a castle"));
        assert!(is_allowed("vamos construir uma casa"));
    }

    #[test]
    fn blocks_profanity_case_insensitively() {
        assert!(!is_allowed("you are a Bitch"));
        assert!(!is_allowed("que MERDA"));
        assert!(!is_allowed("shit!"));
    }

    #[test]
    fn does_not_flag_words_that_merely_contain_a_blocked_substring() {
        assert!(is_allowed("isso foi uma disputa justa"));
        assert!(is_allowed("classic bassline"));
    }

    #[test]
    fn blocks_any_link() {
        assert!(!is_allowed("join me at http://evil.example"));
        assert!(!is_allowed("see www.example.com"));
        assert!(!is_allowed("HTTPS://Example.Com"));
    }
}
