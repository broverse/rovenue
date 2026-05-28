// =============================================================
// M7.1 — EventEnvelope + IdentityContext round-trip tests
// =============================================================

use rovenue::{EventEnvelope, IdentityContext};
use serde_json::Value;

/// 1. Full round-trip: all 9 IdentityContext fields present.
///    Asserts camelCase keys in the serialised JSON.
#[test]
fn full_identity_context_round_trip() {
    let envelope = EventEnvelope {
        event_type: "revenue.event.recorded".to_string(),
        occurred_at: "2026-05-28T10:00:00Z".to_string(),
        subscriber_id: Some("sub_abc".to_string()),
        product_id: Some("prod_xyz".to_string()),
        amount: Some("9.99".to_string()),
        currency: Some("USD".to_string()),
        event_source_url: Some("https://example.com/app".to_string()),
        identity_context: Some(IdentityContext {
            email: Some("user@example.com".to_string()),
            external_id: Some("uid_123".to_string()),
            phone: Some("+15005550006".to_string()),
            ip: Some("203.0.113.1".to_string()),
            user_agent: Some("Mozilla/5.0".to_string()),
            first_name: Some("Jane".to_string()),
            last_name: Some("Doe".to_string()),
            city: Some("Istanbul".to_string()),
            country_code: Some("TR".to_string()),
        }),
    };

    let json_str = serde_json::to_string(&envelope).expect("serialise");
    let v: Value = serde_json::from_str(&json_str).expect("parse");

    // Top-level camelCase keys
    assert!(v.get("identityContext").is_some(), "expected identityContext key");
    assert!(v.get("identity_context").is_none(), "unexpected snake_case key");

    let ic = &v["identityContext"];
    assert_eq!(ic["externalId"], "uid_123");
    assert_eq!(ic["userAgent"], "Mozilla/5.0");
    assert_eq!(ic["firstName"], "Jane");
    assert_eq!(ic["lastName"], "Doe");
    assert_eq!(ic["countryCode"], "TR");
    assert_eq!(ic["email"], "user@example.com");
    assert_eq!(ic["phone"], "+15005550006");
    assert_eq!(ic["ip"], "203.0.113.1");
    assert_eq!(ic["city"], "Istanbul");

    // Deserialise back and confirm field values
    let decoded: EventEnvelope = serde_json::from_str(&json_str).expect("deserialise");
    let ctx = decoded.identity_context.expect("identity_context present");
    assert_eq!(ctx.external_id.as_deref(), Some("uid_123"));
    assert_eq!(ctx.user_agent.as_deref(), Some("Mozilla/5.0"));
}

/// 2. Envelope without identityContext omits the key entirely.
#[test]
fn envelope_without_identity_context_omits_key() {
    let envelope = EventEnvelope {
        event_type: "subscription.trial.started".to_string(),
        occurred_at: "2026-05-28T12:00:00Z".to_string(),
        subscriber_id: Some("sub_no_ic".to_string()),
        product_id: None,
        amount: None,
        currency: None,
        event_source_url: None,
        identity_context: None,
    };

    let json_str = serde_json::to_string(&envelope).expect("serialise");
    let v: Value = serde_json::from_str(&json_str).expect("parse");

    assert!(
        v.get("identityContext").is_none(),
        "identityContext key must be absent when None"
    );
}

/// 3. IdentityContext with only email serialises to `{"email":"a@b.co"}`.
#[test]
fn identity_context_email_only() {
    let ic = IdentityContext {
        email: Some("a@b.co".to_string()),
        ..Default::default()
    };

    let json_str = serde_json::to_string(&ic).expect("serialise");
    let v: Value = serde_json::from_str(&json_str).expect("parse");

    assert_eq!(v, serde_json::json!({"email": "a@b.co"}));
}
