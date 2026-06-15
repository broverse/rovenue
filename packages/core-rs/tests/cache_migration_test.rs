use rovenue::cache::CacheStore;
use tempfile::tempdir;

#[test]
fn opens_fresh_db_runs_all_migrations() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).expect("open fresh db");
    assert_eq!(store.schema_version().unwrap(), 4);
}

#[test]
fn reopens_existing_db_idempotently() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let _a = CacheStore::open(&path).unwrap();
    let b = CacheStore::open(&path).expect("reopen existing");
    assert_eq!(b.schema_version().unwrap(), 4);
}

#[test]
fn creates_expected_tables() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).unwrap();
    for table in [
        "schema_meta",
        "identity",
        "entitlements",
        "etag_cache",
        "credit_balance",
        "app_account_tokens",
        "session_events",
    ] {
        let exists = store.has_table(table).unwrap();
        assert!(exists, "table `{table}` must exist after migrations");
    }
}
