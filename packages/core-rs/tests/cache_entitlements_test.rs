use rovenue::cache::entitlements::{EntitlementRow, EntitlementsRepo};
use rovenue::cache::etag::EtagRepo;
use rovenue::cache::CacheStore;

fn row(entitlement_id: &str) -> EntitlementRow {
    EntitlementRow {
        entitlement_id: entitlement_id.into(),
        is_active: true,
        product_id: Some("monthly".into()),
        product_identifier: "monthly".into(),
        store: "APP_STORE".into(),
        expires_iso: Some("2099-01-01T00:00:00Z".into()),
        expires_at_ms: Some(1_700_000_000_000),
        updated_at_ms: 1,
    }
}

#[test]
fn upsert_and_get_one() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EntitlementsRepo::new(&store);
    repo.upsert_many("user_42", &[row("pro")]).unwrap();
    let got = repo.get("user_42", "pro").unwrap().unwrap();
    assert!(got.is_active);
    assert_eq!(got.entitlement_id, "pro");
    assert_eq!(got.product_identifier, "monthly");
    assert_eq!(got.store, "APP_STORE");
}

#[test]
fn list_all_for_user_scope() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EntitlementsRepo::new(&store);
    repo.upsert_many("user_42", &[row("pro"), row("lifetime")])
        .unwrap();
    repo.upsert_many("other", &[row("pro")]).unwrap();
    let mut got: Vec<String> = repo
        .list("user_42")
        .unwrap()
        .into_iter()
        .map(|e| e.entitlement_id)
        .collect();
    got.sort();
    assert_eq!(got, vec!["lifetime", "pro"]);
}

#[test]
fn etag_roundtrip() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = EtagRepo::new(&store);
    assert!(repo.get("entitlements").unwrap().is_none());
    repo.put("entitlements", "abc123", 100).unwrap();
    assert_eq!(repo.get("entitlements").unwrap().as_deref(), Some("abc123"));
    repo.put("entitlements", "def456", 200).unwrap();
    assert_eq!(repo.get("entitlements").unwrap().as_deref(), Some("def456"));
}
