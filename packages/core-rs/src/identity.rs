use std::sync::{Arc, Mutex};

use crate::cache::identity::{IdentityRepo, IdentityRow};
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;

#[derive(Debug, Clone)]
pub struct User {
    pub rovenue_id: String,
    pub app_user_id: Option<String>,
}

pub struct IdentityManager {
    store: Arc<CacheStore>,
    bus: Arc<ObserverBus>,
    clock: Arc<dyn Clock>,
    cached: Mutex<User>,
}

impl IdentityManager {
    pub fn new(store: Arc<CacheStore>, bus: Arc<ObserverBus>, clock: Arc<dyn Clock>) -> Self {
        let repo = IdentityRepo::new(&store);
        let row = match repo.load().ok().flatten() {
            Some(r) => r,
            None => {
                let new_row = IdentityRow {
                    rovenue_id: format!("rov_{}", cuid2::create_id()),
                    app_user_id: None,
                    synced: true,
                    created_at_ms: clock.now_unix_ms(),
                };
                repo.save(&new_row).expect("persist initial identity");
                new_row
            }
        };
        let user = User {
            rovenue_id: row.rovenue_id,
            app_user_id: row.app_user_id,
        };
        Self {
            store,
            bus,
            clock,
            cached: Mutex::new(user),
        }
    }

    pub fn current_user(&self) -> User {
        self.cached.lock().expect("identity mutex poisoned").clone()
    }

    /// The user scope used by the cache layer — `app_user_id` if identified, else `rovenue_id`.
    pub fn current_user_scope(&self) -> String {
        let u = self.cached.lock().expect("identity mutex poisoned");
        u.app_user_id.clone().unwrap_or_else(|| u.rovenue_id.clone())
    }

    pub fn identify(&self, app_user_id: String) -> RovenueResult<()> {
        if app_user_id.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey); // reuse "invalid input" semantic
        }
        let changed = {
            let mut u = self.cached.lock().expect("identity mutex poisoned");
            if u.app_user_id.as_deref() == Some(app_user_id.as_str()) {
                false
            } else {
                u.app_user_id = Some(app_user_id.clone());
                true
            }
        };
        if changed {
            let row = IdentityRow {
                rovenue_id: self
                    .cached
                    .lock()
                    .expect("identity mutex poisoned")
                    .rovenue_id
                    .clone(),
                app_user_id: Some(app_user_id),
                synced: true,
                created_at_ms: self.clock.now_unix_ms(),
            };
            IdentityRepo::new(&self.store).save(&row)?;
            self.bus.emit(ChangeEvent::IdentityChanged);
        }
        Ok(())
    }
}
