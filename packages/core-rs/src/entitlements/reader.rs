use std::sync::Arc;

use crate::cache::entitlements::EntitlementsRepo;
use crate::cache::CacheStore;
use crate::error::RovenueResult;
use crate::identity::IdentityManager;

use super::types::Entitlement;

pub struct EntitlementReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
}

impl EntitlementReader {
    pub fn new(store: Arc<CacheStore>, identity: Arc<IdentityManager>) -> Self {
        Self { store, identity }
    }

    pub fn get(&self, id: &str) -> RovenueResult<Option<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.get(&scope, id)?.map(row_to_entitlement))
    }

    pub fn list_all(&self) -> RovenueResult<Vec<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.list(&scope)?.into_iter().map(row_to_entitlement).collect())
    }
}

fn row_to_entitlement(r: crate::cache::entitlements::EntitlementRow) -> Entitlement {
    Entitlement {
        id: r.entitlement_id,
        is_active: r.is_active,
        product_id: r.product_id,
        expires_at_ms: r.expires_at_ms,
    }
}
