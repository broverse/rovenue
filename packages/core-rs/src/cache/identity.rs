use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone)]
pub struct IdentityRow {
    pub rovenue_id: String,
    pub app_user_id: Option<String>,
    pub synced: bool,
    pub created_at_ms: u64,
}

pub struct IdentityRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> IdentityRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn load(&self) -> RovenueResult<Option<IdentityRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT rovenue_id, app_user_id, synced, created_at_ms FROM identity WHERE id = 1",
            )?;
            let mut rows = stmt.query([])?;
            if let Some(r) = rows.next()? {
                Ok(Some(IdentityRow {
                    rovenue_id: r.get(0)?,
                    app_user_id: r.get(1)?,
                    synced: r.get::<_, i64>(2)? != 0,
                    created_at_ms: r.get::<_, i64>(3)? as u64,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn save(&self, row: &IdentityRow) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO identity (id, rovenue_id, app_user_id, synced, created_at_ms)
                 VALUES (1, ?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                    rovenue_id = excluded.rovenue_id,
                    app_user_id = excluded.app_user_id,
                    synced = excluded.synced,
                    created_at_ms = excluded.created_at_ms",
                params![
                    row.rovenue_id,
                    row.app_user_id,
                    row.synced as i64,
                    row.created_at_ms as i64
                ],
            )?;
            Ok(())
        })
    }
}
