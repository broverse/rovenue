use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

/// Persistent store for the last-known placement response, mirroring
/// [`OfferingsCacheRepo`](super::offerings::OfferingsCacheRepo). The cached
/// `body` is the raw `PlacementsResponse` JSON (the `data` payload), keyed by
/// `placement:{identifier}` so it can be parsed back and re-resolved (bucket
/// draw + variant selection) when the network is unavailable.
pub struct PlacementsCacheRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> PlacementsCacheRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, resource: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare("SELECT body FROM placements_cache WHERE resource = ?1")?;
            let mut rows = stmt.query(params![resource])?;
            if let Some(r) = rows.next()? {
                Ok(Some(r.get::<_, String>(0)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn put(&self, resource: &str, body: &str, updated_at_ms: u64) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO placements_cache (resource, body, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(resource) DO UPDATE SET
                   body = excluded.body,
                   updated_at_ms = excluded.updated_at_ms",
                params![resource, body, updated_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
