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

pub const MIGRATION_V2: &str = r#"
ALTER TABLE entitlements ADD COLUMN store TEXT NOT NULL DEFAULT '';
ALTER TABLE entitlements ADD COLUMN product_identifier TEXT NOT NULL DEFAULT '';
ALTER TABLE entitlements ADD COLUMN expires_iso TEXT;

CREATE TABLE credit_balance (
    user_scope TEXT PRIMARY KEY,
    balance INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

UPDATE schema_meta SET version = 2;
"#;

pub const MIGRATION_V3: &str = r#"
CREATE TABLE app_account_tokens (
    scope TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    duration_ms INTEGER
);
CREATE INDEX idx_session_events_id ON session_events(id);

UPDATE schema_meta SET version = 3;
"#;

pub const MIGRATION_V4: &str = r#"
DROP TABLE IF EXISTS identity;

CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rovenue_id TEXT NOT NULL,
    app_user_id TEXT,
    synced INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL
);

UPDATE schema_meta SET version = 4;
"#;

pub const MIGRATIONS: &[&str] = &[MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4];
pub const LATEST: u32 = 4;
