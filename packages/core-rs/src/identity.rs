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
        u.app_user_id
            .clone()
            .unwrap_or_else(|| u.rovenue_id.clone())
    }

    /// Optimistic-local identity set. Persists the `app_user_id` with
    /// `synced: false` (a follow-up `POST /v1/identify` flips it to synced via
    /// [`mark_synced`]). Emits `IdentityChanged` only when the value actually
    /// changes. Returns `true` when the identity changed, `false` when it was
    /// already this `app_user_id` (no write, no emit).
    pub fn set_app_user_id(&self, app_user_id: String) -> RovenueResult<bool> {
        if app_user_id.trim().is_empty() {
            return Err(RovenueError::InvalidArgument()); // dedicated invalid-argument error (distinct from InvalidApiKey)
        }
        // Capture `rovenue_id` in the SAME critical section that mutates
        // `app_user_id`, so a concurrent `log_out()` cannot swap the rovenue_id
        // between the read and the persist (which would store a mismatched
        // rovenue_id/app_user_id pair).
        let (changed, rovenue_id) = {
            let mut u = self.cached.lock().expect("identity mutex poisoned");
            if u.app_user_id.as_deref() == Some(app_user_id.as_str()) {
                (false, String::new())
            } else {
                u.app_user_id = Some(app_user_id.clone());
                (true, u.rovenue_id.clone())
            }
        };
        if changed {
            let row = IdentityRow {
                rovenue_id,
                app_user_id: Some(app_user_id),
                synced: false,
                created_at_ms: self.clock.now_unix_ms(),
            };
            IdentityRepo::new(&self.store).save(&row)?;
            self.bus.emit(ChangeEvent::IdentityChanged);
        }
        Ok(changed)
    }

    /// Marks the persisted identity row as synced (server `POST /v1/identify`
    /// succeeded) — but ONLY when the row still carries the `app_user_id` that
    /// was actually sent. This guards the race where `identify(A)`'s slow POST
    /// completes after a concurrent `identify(B)` has already overwritten the
    /// row: without the guard we'd stamp `B` as synced though only `A` was sent,
    /// stranding `B` (never delivered) yet believed-synced. Does not touch the
    /// in-memory `User` or emit — the `app_user_id` is unchanged.
    pub fn mark_synced(&self, for_app_user_id: &str) -> RovenueResult<()> {
        let repo = IdentityRepo::new(&self.store);
        if let Some(mut row) = repo.load()? {
            if !row.synced && row.app_user_id.as_deref() == Some(for_app_user_id) {
                row.synced = true;
                repo.save(&row)?;
            }
        }
        Ok(())
    }

    /// Returns the `app_user_id` awaiting server sync — `Some` only while the
    /// persisted row has `synced == false` and carries an `app_user_id`.
    pub fn pending_app_user_id(&self) -> Option<String> {
        let row = IdentityRepo::new(&self.store).load().ok().flatten()?;
        if row.synced {
            None
        } else {
            row.app_user_id
        }
    }

    /// The current anonymous device id.
    pub fn rovenue_id(&self) -> String {
        self.cached
            .lock()
            .expect("identity mutex poisoned")
            .rovenue_id
            .clone()
    }

    /// Resets identity to a fresh anonymous user: mints a new `rovenue_id`,
    /// drops any `app_user_id`, persists, and notifies observers. Callers that
    /// hold scope-bound caches must clear them after this returns.
    pub fn log_out(&self) -> RovenueResult<()> {
        let new_row = IdentityRow {
            rovenue_id: format!("rov_{}", cuid2::create_id()),
            app_user_id: None,
            synced: true,
            created_at_ms: self.clock.now_unix_ms(),
        };
        IdentityRepo::new(&self.store).save(&new_row)?;
        {
            let mut u = self.cached.lock().expect("identity mutex poisoned");
            u.rovenue_id = new_row.rovenue_id.clone();
            u.app_user_id = None;
        }
        self.bus.emit(ChangeEvent::IdentityChanged);
        Ok(())
    }
}
