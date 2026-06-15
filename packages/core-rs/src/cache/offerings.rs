use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

/// Persistent store for the last-known offerings response, mirroring
/// [`EtagRepo`](super::etag::EtagRepo). The cached `body` is the raw
/// `OfferingsResponse` JSON (the `data` payload), keyed by a stable resource
/// name so it can be parsed back and remapped when the network is unavailable.
pub struct OfferingsCacheRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> OfferingsCacheRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, resource: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare("SELECT body FROM offerings_cache WHERE resource = ?1")?;
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
                "INSERT INTO offerings_cache (resource, body, updated_at_ms)
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
