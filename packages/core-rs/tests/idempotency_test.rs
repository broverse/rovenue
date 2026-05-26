use rovenue::transport::idempotency::IdempotencyKey;

#[test]
fn new_key_has_prefix_and_is_unique() {
    let k1 = IdempotencyKey::new();
    let k2 = IdempotencyKey::new();
    assert!(k1.as_str().starts_with("idem_"));
    assert_ne!(k1.as_str(), k2.as_str());
}

#[test]
fn clone_keeps_the_same_string() {
    let k = IdempotencyKey::new();
    let s1 = k.as_str().to_owned();
    let cloned = k.clone();
    assert_eq!(cloned.as_str(), s1);
}

#[test]
fn key_under_255_chars() {
    let k = IdempotencyKey::new();
    assert!(k.as_str().len() <= 255, "server rejects keys > 255 chars");
}
