use rusqlite::params;

use crate::error::RovenueResult;

use super::CacheStore;

#[derive(Debug, Clone)]
pub struct EntitlementRow {
    pub entitlement_id: String,
    pub is_active: bool,
    pub product_id: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub updated_at_ms: u64,
}

pub struct EntitlementsRepo<'a> {
    store: &'a CacheStore,
}

impl<'a> EntitlementsRepo<'a> {
    pub fn new(store: &'a CacheStore) -> Self {
        Self { store }
    }

    pub fn upsert_many(&self, user_scope: &str, rows: &[EntitlementRow]) -> RovenueResult<()> {
        self.store.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO entitlements
                       (user_scope, entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(user_scope, entitlement_id) DO UPDATE SET
                       is_active = excluded.is_active,
                       product_id = excluded.product_id,
                       expires_at_ms = excluded.expires_at_ms,
                       updated_at_ms = excluded.updated_at_ms",
                )?;
                for r in rows {
                    stmt.execute(params![
                        user_scope,
                        r.entitlement_id,
                        r.is_active as i64,
                        r.product_id,
                        r.expires_at_ms.map(|v| v as i64),
                        r.updated_at_ms as i64,
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn get(&self, user_scope: &str, entitlement_id: &str) -> RovenueResult<Option<EntitlementRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms
                 FROM entitlements WHERE user_scope = ?1 AND entitlement_id = ?2",
            )?;
            let mut rows = stmt.query(params![user_scope, entitlement_id])?;
            if let Some(r) = rows.next()? {
                Ok(Some(EntitlementRow {
                    entitlement_id: r.get(0)?,
                    is_active: r.get::<_, i64>(1)? != 0,
                    product_id: r.get(2)?,
                    expires_at_ms: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    updated_at_ms: r.get::<_, i64>(4)? as u64,
                }))
            } else {
                Ok(None)
            }
        })
    }

    pub fn list(&self, user_scope: &str) -> RovenueResult<Vec<EntitlementRow>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT entitlement_id, is_active, product_id, expires_at_ms, updated_at_ms
                 FROM entitlements WHERE user_scope = ?1",
            )?;
            let mut rows = stmt.query(params![user_scope])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                out.push(EntitlementRow {
                    entitlement_id: r.get(0)?,
                    is_active: r.get::<_, i64>(1)? != 0,
                    product_id: r.get(2)?,
                    expires_at_ms: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    updated_at_ms: r.get::<_, i64>(4)? as u64,
                });
            }
            Ok(out)
        })
    }
}
