use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

/// Persistent store for the last-known Remote Config response, mirroring
/// [`OfferingsCacheRepo`](super::offerings::OfferingsCacheRepo). The cached
/// `body` is the raw `ConfigResponse` JSON (the `data` payload) keyed by a
/// stable resource name so flags/experiments keep resolving offline.
pub struct RemoteConfigCacheRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> RemoteConfigCacheRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, resource: &str) -> RovenueResult<Option<String>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare("SELECT body FROM remote_config_cache WHERE resource = ?1")?;
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
                "INSERT INTO remote_config_cache (resource, body, updated_at_ms)
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
