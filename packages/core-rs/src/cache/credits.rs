use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone, PartialEq)]
pub struct CreditBalanceRow {
    pub user_scope: String,
    pub balance: i64,
    pub updated_at_ms: u64,
}

pub struct CreditBalanceRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> CreditBalanceRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn get(&self, user_scope: &str) -> RovenueResult<Option<CreditBalanceRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT user_scope, balance, updated_at_ms FROM credit_balance WHERE user_scope = ?1",
            )?;
            let mut rows = stmt.query(params![user_scope])?;
            if let Some(r) = rows.next()? {
                Ok(Some(CreditBalanceRow {
                    user_scope: r.get(0)?,
                    balance: r.get(1)?,
                    updated_at_ms: r.get::<_, i64>(2)? as u64,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn upsert(&self, row: &CreditBalanceRow) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO credit_balance (user_scope, balance, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(user_scope) DO UPDATE SET
                   balance = excluded.balance,
                   updated_at_ms = excluded.updated_at_ms",
                params![row.user_scope, row.balance, row.updated_at_ms as i64],
            )?;
            Ok(())
        })
    }
}
