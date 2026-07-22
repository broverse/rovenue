use rovenue::cache::CacheStore;
use tempfile::tempdir;

#[test]
fn opens_fresh_db_runs_all_migrations() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let store = CacheStore::open(&path).expect("open fresh db");
    assert_eq!(store.schema_version().unwrap(), 11);
}

#[test]
fn reopens_existing_db_idempotently() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rovenue.db");
    let _a = CacheStore::open(&path).unwrap();
    let b = CacheStore::open(&path).expect("reopen existing");
    assert_eq!(b.schema_version().unwrap(), 11);
}

#[test]
fn migration_v8_creates_virtual_currency_and_exposure_tables() {
    let store = CacheStore::open_in_memory().unwrap();
    // schema is migrated to LATEST on open
    let version = store
        .with_conn(|c| {
            let v: u32 = c.query_row("SELECT version FROM schema_meta", [], |r| r.get(0))?;
            Ok(v)
        })
        .unwrap();
    assert_eq!(version, 11, "LATEST schema version should be 11");

    // both new tables must exist and be writable
    store
        .with_conn(|c| {
            c.execute(
                "INSERT INTO virtual_currency_balance (user_scope, code, balance, updated_at_ms) VALUES ('s','gold',5,1)",
                [],
            )?;
            c.execute(
                "INSERT INTO experiment_exposure (user_scope, experiment_id, variant_id, exposed_at_ms) VALUES ('s','e1','v1',1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
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
        "offerings_cache",
        "attribute_mutations",
        "remote_config_cache",
        "virtual_currency_balance",
        "experiment_exposure",
        "funnel_install",
        "funnel_claim_state",
        "placements_cache",
        "paywall_events",
    ] {
        let exists = store.has_table(table).unwrap();
        assert!(exists, "table `{table}` must exist after migrations");
    }
}

#[test]
fn migration_v9_creates_funnel_tables() {
    let store = CacheStore::open_in_memory().unwrap();
    // both funnel tables (added in MIGRATION_V9) must exist and be writable
    store
        .with_conn(|c| {
            c.execute(
                "INSERT INTO funnel_install (id, install_id, created_at_ms) VALUES (1, 'inst_1', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO funnel_claim_state (install_id, state, created_at_ms) VALUES ('inst_1', 'claimed', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn migration_v11_creates_paywall_events_table() {
    let store = CacheStore::open_in_memory().unwrap();
    // the durable paywall_* event queue (spec D4) — must exist and be writable
    store
        .with_conn(|c| {
            c.execute(
                "INSERT INTO paywall_events (envelope_json) VALUES ('{\"eventType\":\"paywall_view\"}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
}
