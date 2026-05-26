use rovenue::cache::CacheStore;
use rovenue::cache::identity::{IdentityRow, IdentityRepo};

#[test]
fn no_identity_returns_none() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = IdentityRepo::new(&store);
    assert!(repo.load().unwrap().is_none());
}

#[test]
fn persist_and_reload() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = IdentityRepo::new(&store);
    let row = IdentityRow {
        anon_id: "anon_abc".into(),
        known_user_id: None,
        created_at_ms: 1_700_000_000_000,
    };
    repo.save(&row).unwrap();
    let loaded = repo.load().unwrap().unwrap();
    assert_eq!(loaded.anon_id, "anon_abc");
    assert!(loaded.known_user_id.is_none());
    assert_eq!(loaded.created_at_ms, 1_700_000_000_000);
}

#[test]
fn save_is_upsert_keeps_one_row() {
    let store = CacheStore::open_in_memory().unwrap();
    let repo = IdentityRepo::new(&store);
    let mut row = IdentityRow {
        anon_id: "anon_abc".into(),
        known_user_id: None,
        created_at_ms: 1,
    };
    repo.save(&row).unwrap();
    row.known_user_id = Some("user_42".into());
    repo.save(&row).unwrap();
    let count: i64 = store
        .with_conn(|c| c.query_row("SELECT COUNT(*) FROM identity", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(count, 1);
    let loaded = repo.load().unwrap().unwrap();
    assert_eq!(loaded.known_user_id.as_deref(), Some("user_42"));
}
