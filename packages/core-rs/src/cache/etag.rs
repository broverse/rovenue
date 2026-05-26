use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

pub struct EtagRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> EtagRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, resource: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare("SELECT etag FROM etag_cache WHERE resource = ?1")?;
            let mut rows = stmt.query(params![resource])?;
            if let Some(r) = rows.next()? {
                Ok(Some(r.get::<_, String>(0)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn put(&self, resource: &str, etag: &str, updated_at_ms: u64) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO etag_cache (resource, etag, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(resource) DO UPDATE SET
                   etag = excluded.etag,
                   updated_at_ms = excluded.updated_at_ms",
                params![resource, etag, updated_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
