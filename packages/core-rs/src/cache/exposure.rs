use std::sync::Arc;

use rusqlite::params;

use super::store::CacheStore;
use crate::error::RovenueResult;

/// Append-only dedup ledger: one row per (scope, experiment, variant) that
/// has already been reported as exposed. A variant change yields a new
/// (experiment_id, variant_id) pair → a fresh exposure.
pub struct ExposureRepo {
    store: Arc<CacheStore>,
}

impl ExposureRepo {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    pub fn is_exposed(
        &self,
        user_scope: &str,
        experiment_id: &str,
        variant_id: &str,
    ) -> RovenueResult<bool> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT 1 FROM experiment_exposure
                 WHERE user_scope = ?1 AND experiment_id = ?2 AND variant_id = ?3",
            )?;
            let mut rows = stmt.query(params![user_scope, experiment_id, variant_id])?;
            Ok(rows.next()?.is_some())
        })
    }

    pub fn mark(
        &self,
        user_scope: &str,
        experiment_id: &str,
        variant_id: &str,
        exposed_at_ms: u64,
    ) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT OR IGNORE INTO experiment_exposure
                   (user_scope, experiment_id, variant_id, exposed_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![user_scope, experiment_id, variant_id, exposed_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
