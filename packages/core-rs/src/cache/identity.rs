use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone)]
pub struct IdentityRow {
    pub anon_id: String,
    pub known_user_id: Option<String>,
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
                "SELECT anon_id, known_user_id, created_at_ms FROM identity WHERE id = 1",
            )?;
            let mut rows = stmt.query([])?;
            if let Some(r) = rows.next()? {
                Ok(Some(IdentityRow {
                    anon_id: r.get(0)?,
                    known_user_id: r.get(1)?,
                    created_at_ms: r.get::<_, i64>(2)? as u64,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn save(&self, row: &IdentityRow) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO identity (id, anon_id, known_user_id, created_at_ms)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    anon_id = excluded.anon_id,
                    known_user_id = excluded.known_user_id,
                    created_at_ms = excluded.created_at_ms",
                params![row.anon_id, row.known_user_id, row.created_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
