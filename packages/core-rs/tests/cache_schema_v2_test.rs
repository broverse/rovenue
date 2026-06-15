use rovenue::cache::CacheStore;
use tempfile::tempdir;

#[test]
fn fresh_db_runs_v1_then_v2() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).expect("open fresh db");
    assert_eq!(store.schema_version().unwrap(), 4);
    assert!(store.has_table("credit_balance").unwrap());
}

#[test]
fn entitlements_v2_columns_present() {
    let store = CacheStore::open_in_memory().unwrap();
    let count: i64 = store
        .with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entitlements') \
                 WHERE name IN ('store','product_identifier','expires_iso')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        count, 3,
        "v2 columns store/product_identifier/expires_iso must exist"
    );
}

#[test]
fn upgrades_v1_db_in_place() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");

    // Manually create a v1 db.
    {
        use rusqlite::Connection;
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(rovenue::cache::schema::MIGRATION_V1)
            .unwrap();
    }

    let store = CacheStore::open(&path).expect("reopen + upgrade v1→v2");
    assert_eq!(store.schema_version().unwrap(), 4);
    assert!(store.has_table("credit_balance").unwrap());
}
