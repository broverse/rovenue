use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{RovenueError, RovenueResult};

use super::schema::{LATEST, MIGRATIONS};

#[derive(Debug, Clone)]
pub struct SessionEventRow {
    pub id: i64,
    pub kind: String,
    pub occurred_at: String,
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct AttributeMutationRow {
    pub id: i64,
    pub key: String,
    /// None means "delete this key".
    pub value: Option<String>,
}

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
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> RovenueResult<Self> {
        let conn = Connection::open_in_memory().map_err(|_| RovenueError::Storage)?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
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
            .query_row("SELECT version FROM schema_meta LIMIT 1", [], |r| {
                r.get::<_, u32>(0)
            })
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
    pub fn with_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> RovenueResult<R> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        f(&guard).map_err(|_| RovenueError::Storage)
    }

    /// Latest schema version the binary knows how to apply.
    pub const fn latest_schema_version() -> u32 {
        LATEST
    }

    pub fn get_app_account_token(&self, scope: &str) -> RovenueResult<Option<String>> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .query_row(
                "SELECT token FROM app_account_tokens WHERE scope = ?1",
                [scope],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| RovenueError::Storage)
    }

    pub fn put_app_account_token(&self, scope: &str, token: &str) -> RovenueResult<()> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        // INSERT OR IGNORE so the first writer wins — idempotent.
        guard
            .execute(
                "INSERT OR IGNORE INTO app_account_tokens (scope, token, created_at) \
                 VALUES (?1, ?2, datetime('now'))",
                [scope, token],
            )
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    /// Wipes every app account token. Used on log_out — tokens are bound to the
    /// previous identity scope and must not carry over to the next user.
    pub fn clear_app_account_tokens(&self) -> RovenueResult<()> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .execute("DELETE FROM app_account_tokens", [])
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn count_app_account_tokens(&self) -> RovenueResult<i64> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .query_row("SELECT COUNT(*) FROM app_account_tokens", [], |r| r.get(0))
            .map_err(|_| RovenueError::Storage)
    }

    pub fn append_session_event(
        &self,
        kind: &str,
        occurred_at: &str,
        duration_ms: Option<u32>,
    ) -> RovenueResult<()> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .execute(
                "INSERT INTO session_events (kind, occurred_at, duration_ms) \
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![kind, occurred_at, duration_ms],
            )
            .map_err(|_| RovenueError::Storage)?;
        // FIFO trim — keep newest 1000.
        guard
            .execute(
                "DELETE FROM session_events WHERE id NOT IN \
                 (SELECT id FROM session_events ORDER BY id DESC LIMIT 1000)",
                [],
            )
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    /// Wipes every buffered session event. Used on log_out — undispatched events
    /// belong to the previous identity scope and must not flush under the next user.
    pub fn clear_session_events(&self) -> RovenueResult<()> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .execute("DELETE FROM session_events", [])
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn list_session_events(&self, limit: usize) -> RovenueResult<Vec<SessionEventRow>> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        let mut stmt = guard
            .prepare(
                "SELECT id, kind, occurred_at, duration_ms FROM session_events \
                 ORDER BY id ASC LIMIT ?1",
            )
            .map_err(|_| RovenueError::Storage)?;
        let rows = stmt
            .query_map([limit as i64], |r| {
                Ok(SessionEventRow {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    occurred_at: r.get(2)?,
                    duration_ms: r.get(3)?,
                })
            })
            .map_err(|_| RovenueError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| RovenueError::Storage)?;
        Ok(rows)
    }

    pub fn delete_session_events(&self, ids: &[i64]) -> RovenueResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("DELETE FROM session_events WHERE id IN ({})", placeholders);
        let params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        guard
            .execute(&sql, params.as_slice())
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn append_attribute_mutation(
        &self,
        key: &str,
        value: Option<&str>,
    ) -> RovenueResult<()> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .execute(
                "INSERT INTO attribute_mutations (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value],
            )
            .map_err(|_| RovenueError::Storage)?;
        // FIFO trim — keep newest 1000 (backstop for an endlessly-failing flush).
        guard
            .execute(
                "DELETE FROM attribute_mutations WHERE id NOT IN \
                 (SELECT id FROM attribute_mutations ORDER BY id DESC LIMIT 1000)",
                [],
            )
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn list_attribute_mutations(
        &self,
        limit: usize,
    ) -> RovenueResult<Vec<AttributeMutationRow>> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        let mut stmt = guard
            .prepare(
                "SELECT id, key, value FROM attribute_mutations \
                 ORDER BY id ASC LIMIT ?1",
            )
            .map_err(|_| RovenueError::Storage)?;
        let rows = stmt
            .query_map([limit as i64], |r| {
                Ok(AttributeMutationRow {
                    id: r.get(0)?,
                    key: r.get(1)?,
                    value: r.get(2)?,
                })
            })
            .map_err(|_| RovenueError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| RovenueError::Storage)?;
        Ok(rows)
    }

    pub fn delete_attribute_mutations(&self, ids: &[i64]) -> RovenueResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "DELETE FROM attribute_mutations WHERE id IN ({})",
            placeholders
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        guard
            .execute(&sql, params.as_slice())
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }

    pub fn clear_attribute_mutations(&self) -> RovenueResult<()> {
        let guard = self.conn.lock().map_err(|_| RovenueError::Storage)?;
        guard
            .execute("DELETE FROM attribute_mutations", [])
            .map_err(|_| RovenueError::Storage)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_account_tokens_table_round_trip() {
        let store = CacheStore::open_in_memory().unwrap();
        let scope = "subscriber-abc";
        // Returns None when empty.
        assert_eq!(store.get_app_account_token(scope).unwrap(), None);
        // Insert + read back.
        store
            .put_app_account_token(scope, "550e8400-e29b-41d4-a716-446655440000")
            .unwrap();
        assert_eq!(
            store.get_app_account_token(scope).unwrap(),
            Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
        );
        // Idempotent: re-insert same scope is a no-op (does not overwrite).
        store
            .put_app_account_token(scope, "different-uuid")
            .unwrap();
        assert_eq!(
            store.get_app_account_token(scope).unwrap(),
            Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
        );
    }

    #[test]
    fn session_events_fifo_drop_at_cap() {
        let store = CacheStore::open_in_memory().unwrap();
        for i in 0..1005 {
            store
                .append_session_event(
                    "open",
                    &format!("2026-05-28T10:00:{:02}Z", i % 60),
                    None,
                )
                .unwrap();
        }
        let rows = store.list_session_events(2000).unwrap();
        // FIFO drop: at cap 1000, the oldest 5 are gone — newest 1000 remain.
        assert_eq!(rows.len(), 1000);
        // Cleared on flush.
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        store.delete_session_events(&ids).unwrap();
        assert_eq!(store.list_session_events(2000).unwrap().len(), 0);
    }

    #[test]
    fn attribute_mutations_crud() {
        let store = CacheStore::open_in_memory().unwrap();
        store.append_attribute_mutation("$email", Some("a@b.com")).unwrap();
        store.append_attribute_mutation("favoriteTeam", Some("GS")).unwrap();
        store.append_attribute_mutation("country", None).unwrap(); // delete marker

        let rows = store.list_attribute_mutations(100).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].key, "$email");
        assert_eq!(rows[0].value.as_deref(), Some("a@b.com"));
        assert_eq!(rows[2].key, "country");
        assert_eq!(rows[2].value, None);

        let ids: Vec<i64> = rows.iter().take(2).map(|r| r.id).collect();
        store.delete_attribute_mutations(&ids).unwrap();
        assert_eq!(store.list_attribute_mutations(100).unwrap().len(), 1);

        store.clear_attribute_mutations().unwrap();
        assert_eq!(store.list_attribute_mutations(100).unwrap().len(), 0);
    }
}
