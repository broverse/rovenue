use std::collections::BTreeMap;
use std::sync::Arc;

use rusqlite::params;

use super::store::CacheStore;
use crate::error::RovenueResult;

/// Per-scope multi-currency balances. Keyed by (user_scope, code); a scope
/// may hold balances in several currencies at once.
pub struct VirtualCurrencyRepo {
    store: Arc<CacheStore>,
}

impl VirtualCurrencyRepo {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    /// All balances for a scope, ordered by code for stable snapshotting.
    pub fn get_all(&self, user_scope: &str) -> RovenueResult<BTreeMap<String, i64>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT code, balance FROM virtual_currency_balance WHERE user_scope = ?1 ORDER BY code",
            )?;
            let mut rows = stmt.query(params![user_scope])?;
            let mut out = BTreeMap::new();
            while let Some(r) = rows.next()? {
                let code: String = r.get(0)?;
                let balance: i64 = r.get(1)?;
                out.insert(code, balance);
            }
            Ok(out)
        })
    }

    /// Single-currency convenience.
    pub fn get(&self, user_scope: &str, code: &str) -> RovenueResult<Option<i64>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT balance FROM virtual_currency_balance WHERE user_scope = ?1 AND code = ?2",
            )?;
            let mut rows = stmt.query(params![user_scope, code])?;
            if let Some(r) = rows.next()? {
                Ok(Some(r.get::<_, i64>(0)?))
            } else {
                Ok(None)
            }
        })
    }

    /// Replace the full balance set for a scope (the server response is
    /// authoritative — currencies absent from `balances` are removed).
    pub fn upsert_all(
        &self,
        user_scope: &str,
        balances: &BTreeMap<String, i64>,
        updated_at_ms: u64,
    ) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            // Delete all existing rows for this scope first (server is authoritative).
            c.execute(
                "DELETE FROM virtual_currency_balance WHERE user_scope = ?1",
                params![user_scope],
            )?;
            for (code, balance) in balances {
                c.execute(
                    "INSERT INTO virtual_currency_balance (user_scope, code, balance, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![user_scope, code, balance, updated_at_ms as i64],
                )?;
            }
            Ok(())
        })
    }
}
