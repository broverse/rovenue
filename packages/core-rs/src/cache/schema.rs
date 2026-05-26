pub const MIGRATION_V1: &str = r#"
CREATE TABLE schema_meta (
    version INTEGER PRIMARY KEY
);

CREATE TABLE identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    anon_id TEXT NOT NULL,
    known_user_id TEXT,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE entitlements (
    user_scope TEXT NOT NULL,
    entitlement_id TEXT NOT NULL,
    is_active INTEGER NOT NULL,
    product_id TEXT,
    expires_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_scope, entitlement_id)
);

CREATE TABLE etag_cache (
    resource TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

INSERT INTO schema_meta (version) VALUES (1);
"#;

pub const MIGRATIONS: &[&str] = &[MIGRATION_V1];
pub const LATEST: u32 = 1;
