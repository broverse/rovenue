use std::collections::BTreeMap;

const SENSITIVE_KEY_TOKENS: &[&str] = &[
    "token", "receipt", "email", "app_user_id", "authorization",
    "signature", "jws", "password", "secret",
];

pub fn redact_fields(fields: BTreeMap<String, String>) -> BTreeMap<String, String> {
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
        if word.contains('@') && word.contains('.') {
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
        if tok == "Bearer" {
            if tokens.next().is_some() {
                result.push_str(" [redacted]");
            }
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
        let mut f = BTreeMap::new();
        f.insert("status".to_string(), "401".to_string());
        f.insert("authorization".to_string(), "Bearer pk_live_abc".to_string());
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
        assert_eq!(redact_message("request timed out after 3 attempts"), "request timed out after 3 attempts");
    }
}
