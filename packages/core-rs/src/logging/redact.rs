use std::collections::HashMap;

const SENSITIVE_KEY_TOKENS: &[&str] = &[
    "token",
    "receipt",
    "email",
    "app_user_id",
    "authorization",
    "signature",
    "jws",
    "password",
    "secret",
];

/// Known credential prefixes (case-insensitive) — any token starting with
/// one of these is treated as a credential and masked.
const CREDENTIAL_PREFIXES: &[&str] =
    &["pk_", "sk_", "rk_", "user_", "sub_", "rcpt", "cus_", "tok_"];

/// Minimum length for an opaque run of `[A-Za-z0-9_\-]` characters that
/// should be treated as a secret identifier / key.
const OPAQUE_TOKEN_MIN_LEN: usize = 20;

/// Returns `true` if `word` looks like a secret/credential that should be
/// redacted from log messages.
fn is_secret_token(word: &str) -> bool {
    // 1. Email: contains '@' and '.' (already handled in the loop, but keep
    //    the predicate complete for standalone use).
    if word.contains('@') && word.contains('.') {
        return true;
    }

    // 2. Known credential prefix (case-insensitive).
    let lower = word.to_lowercase();
    if CREDENTIAL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }

    // 3. JWS/JWT-ish: contains two or more '.' with non-trivial alphanumeric
    //    segments (at least 4 chars each) between them.
    {
        let parts: Vec<&str> = word.split('.').collect();
        if parts.len() >= 3
            && parts.iter().all(|p| {
                p.len() >= 4
                    && p.chars()
                        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
            })
        {
            return true;
        }
    }

    // 4. Long opaque run: ≥ 20 chars, only [A-Za-z0-9_\-].
    if word.len() >= OPAQUE_TOKEN_MIN_LEN
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return true;
    }

    false
}

pub fn redact_fields(fields: HashMap<String, String>) -> HashMap<String, String> {
    fields
        .into_iter()
        .map(|(k, v)| {
            let lk = k.to_lowercase();
            if SENSITIVE_KEY_TOKENS.iter().any(|t| lk.contains(t)) {
                (k, "[redacted]".to_string())
            } else {
                (k, v)
            }
        })
        .collect()
}

pub fn redact_message(input: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for word in input.split_whitespace() {
        if is_secret_token(word) {
            out.push("[redacted]".to_string());
        } else {
            out.push(word.to_string());
        }
    }
    let joined = out.join(" ");
    // Collapse `Bearer <token>` → `Bearer [redacted]`.
    redact_bearer(&joined)
}

fn redact_bearer(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut tokens = s.split(' ').peekable();
    while let Some(tok) = tokens.next() {
        result.push_str(tok);
        if tok == "Bearer" && tokens.next().is_some() {
            result.push_str(" [redacted]");
        }
        if tokens.peek().is_some() {
            result.push(' ');
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_with_sensitive_keys_are_masked() {
        let mut f = HashMap::new();
        f.insert("status".to_string(), "401".to_string());
        f.insert(
            "authorization".to_string(),
            "Bearer pk_live_abc".to_string(),
        );
        f.insert("app_user_id".to_string(), "user_42".to_string());
        f.insert("receipt_data".to_string(), "MIIxyz".to_string());
        let out = redact_fields(f);
        assert_eq!(out.get("status").unwrap(), "401");
        assert_eq!(out.get("authorization").unwrap(), "[redacted]");
        assert_eq!(out.get("app_user_id").unwrap(), "[redacted]");
        assert_eq!(out.get("receipt_data").unwrap(), "[redacted]");
    }

    #[test]
    fn message_masks_bearer_and_email() {
        let m = redact_message("auth Bearer pk_live_secret failed for jane@example.com");
        assert!(!m.contains("pk_live_secret"), "bearer token leaked: {m}");
        assert!(!m.contains("jane@example.com"), "email leaked: {m}");
        assert!(m.contains("[redacted]"));
    }

    #[test]
    fn clean_message_is_unchanged() {
        assert_eq!(
            redact_message("request timed out after 3 attempts"),
            "request timed out after 3 attempts"
        );
    }

    #[test]
    fn message_masks_credential_prefix_tokens() {
        // pk_ prefix
        let m = redact_message("configure pk_live_abc123XYZ failed");
        assert!(!m.contains("pk_live_abc123XYZ"), "pk_ token leaked: {m}");
        assert!(m.contains("[redacted]"), "pk_ token not masked: {m}");

        // sk_ prefix
        let m2 = redact_message("secret sk_test_xyz used");
        assert!(!m2.contains("sk_test_xyz"), "sk_ token leaked: {m2}");

        // user_ prefix
        let m3 = redact_message("subscriber user_42 not found");
        assert!(!m3.contains("user_42"), "user_ id leaked: {m3}");
        assert!(m3.contains("[redacted]"), "user_ id not masked: {m3}");
    }

    #[test]
    fn message_masks_long_opaque_tokens() {
        // 30-char hex/base64url token (≥ 20 chars, only [A-Za-z0-9_\-])
        let long_token = "aB3xK9mZqL7nP2rTvWsYdCeUfGhIjOk"; // 32 chars
        assert!(long_token.len() >= 20);
        let m = redact_message(&format!("token value is {long_token} here"));
        assert!(!m.contains(long_token), "long token leaked: {m}");
        assert!(m.contains("[redacted]"), "long token not masked: {m}");
    }

    #[test]
    fn message_masks_jws_jwt_tokens() {
        // Realistic JWT/JWS shape: three base64url segments separated by '.'
        let jws = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c3JfMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36PO";
        let m = redact_message(&format!("got jws {jws} for request"));
        assert!(!m.contains(jws), "JWS leaked: {m}");
        assert!(m.contains("[redacted]"), "JWS not masked: {m}");
    }

    #[test]
    fn message_does_not_over_redact_normal_words() {
        // Short plain words, numbers, HTTP status phrases must pass through.
        let cases = ["request timed out after 3 attempts", "status 404 not found"];
        for case in &cases {
            let m = redact_message(case);
            assert_eq!(m, *case, "normal message was over-redacted: {m}");
        }
    }
}
