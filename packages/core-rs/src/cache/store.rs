use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{RovenueError, RovenueResult};

use super::schema::{MIGRATIONS, LATEST};

pub struct CacheStore {
    conn: Mutex<Connection>,
}

impl CacheStore {
    pub fn open(path: &Path) -> RovenueResult<Self> {
        let conn = Connection::open(path).map_err(|_| RovenueError::Storage)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        Self::run_migrations(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_in_memory() -> RovenueResult<Self> {
        let conn = Connection::open_in_memory().map_err(|_| RovenueError::Storage)?;
        Self::run_migrations(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn run_migrations(conn: &Connection) -> RovenueResult<()> {
        let current: u32 = conn
            .query_row("SELECT version FROM schema_meta LIMIT 1", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);

        for (idx, sql) in MIGRATIONS.iter().enumerate() {
            let target = idx as u32 + 1;
            if current < target {
                conn.execute_batch(sql).map_err(|_| RovenueError::Storage)?;
            }
        }
        Ok(())
    }

    pub fn schema_version(&self) -> RovenueResult<u32> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .query_row("SELECT version FROM schema_meta LIMIT 1", [], |r| r.get::<_, u32>(0))
            .map_err(|_| RovenueError::Storage)
    }

    pub fn has_table(&self, name: &str) -> RovenueResult<bool> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        let count: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(|_| RovenueError::Storage)?;
        Ok(count > 0)
    }

    /// Internal accessor used by sibling modules (identity, entitlements, etag).
    pub(crate) fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> RovenueResult<R> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        f(&guard).map_err(|_| RovenueError::Storage)
    }

    /// Latest schema version the binary knows how to apply.
    pub const fn latest_schema_version() -> u32 {
        LATEST
    }
}
