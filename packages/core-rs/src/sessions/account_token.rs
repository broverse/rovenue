use std::sync::Arc;

use uuid::Uuid;

use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};

pub struct AccountTokenStore {
    store: Arc<CacheStore>,
}

impl AccountTokenStore {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }

    /// Returns the stable token for the given scope (typically the
    /// subscriber's rovenue_id or app_user_id). Generates + persists on
    /// first call; subsequent calls return the same UUID.
    pub fn get_or_create(&self, scope: &str) -> RovenueResult<String> {
        if scope.trim().is_empty() {
            return Err(RovenueError::Internal);
        }
        if let Some(existing) = self.store.get_app_account_token(scope)? {
            return Ok(existing);
        }
        let new_token = Uuid::new_v4().to_string();
        self.store.put_app_account_token(scope, &new_token)?;
        // Re-read to handle race: another caller may have inserted first.
        self.store
            .get_app_account_token(scope)?
            .ok_or(RovenueError::Storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_same_token_on_repeat_calls() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        let t1 = svc.get_or_create("user-a").unwrap();
        let t2 = svc.get_or_create("user-a").unwrap();
        assert_eq!(t1, t2);
    }

    #[test]
    fn different_scopes_get_different_tokens() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        assert_ne!(
            svc.get_or_create("user-a").unwrap(),
            svc.get_or_create("user-b").unwrap(),
        );
    }

    #[test]
    fn token_is_valid_uuid_v4() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        let t = svc.get_or_create("user-a").unwrap();
        let parsed = Uuid::parse_str(&t).expect("valid UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn empty_scope_returns_internal_error() {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let svc = AccountTokenStore::new(Arc::clone(&store));
        assert!(svc.get_or_create("").is_err());
    }
}
