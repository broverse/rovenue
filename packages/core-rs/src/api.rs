use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::cache::CacheStore;
use crate::config::Config;
use crate::credits::CreditReader;
use crate::entitlements::{Entitlement, EntitlementReader};
use crate::error::{RovenueError, RovenueResult};
use crate::identify::IdentifyClient;
use crate::identity::{IdentityManager, User};
use crate::observer::{Observer, ObserverBus};
use crate::offerings::{CoreOfferings, OfferingsClient};
use crate::polling::PollingScheduler;
use crate::receipts::{ReceiptClient, ReceiptResult};
use crate::sessions::{AccountTokenStore, SessionBuffer, SessionDispatcher, SessionEventKind};
use crate::time::{Clock, SystemClock};
use crate::transport::http_client::HttpClient;
use crate::transport::idempotency::IdempotencyKey;
use crate::version::SDK_VERSION;

const ENTITLEMENTS_INTERVAL_MS: u64 = 30_000;

pub struct RovenueCore {
    _config: Arc<Config>,
    bus: Arc<ObserverBus>,
    identity: Arc<IdentityManager>,
    entitlements: Arc<EntitlementReader>,
    credits: Arc<CreditReader>,
    receipts: Arc<ReceiptClient>,
    offerings: Arc<OfferingsClient>,
    identify: Arc<IdentifyClient>,
    account_tokens: Arc<AccountTokenStore>,
    sessions: Arc<SessionBuffer>,
    session_dispatcher: Arc<SessionDispatcher>,
    scheduler: PollingScheduler,
    store: Arc<CacheStore>,
}

impl RovenueCore {
    pub fn new(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        let store = Arc::new(CacheStore::open(&default_db_path()?)?);
        Self::from_store(config, store)
    }

    fn from_store(config: Config, store: Arc<CacheStore>) -> RovenueResult<Self> {
        let bus = Arc::new(ObserverBus::default());
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store_for_self = Arc::clone(&store);
        let identity = Arc::new(IdentityManager::new(
            Arc::clone(&store),
            Arc::clone(&bus),
            Arc::clone(&clock),
        ));
        let http = Arc::new(HttpClient::new(
            config.base_url.clone(),
            config.api_key.clone(),
        ));
        let reader = Arc::new(
            EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let credits = Arc::new(
            CreditReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let receipts = Arc::new(ReceiptClient::new(Arc::clone(&http)));
        let offerings = Arc::new(OfferingsClient::new(Arc::clone(&http)));
        let identify = Arc::new(IdentifyClient::new(Arc::clone(&http)));
        let account_tokens = Arc::new(AccountTokenStore::new(Arc::clone(&store)));
        let sessions = Arc::new(SessionBuffer::new(Arc::clone(&store)));
        let identity_for_sub = Arc::clone(&identity);
        let session_dispatcher = Arc::new(SessionDispatcher::new(
            Arc::clone(&sessions),
            Arc::clone(&http),
            Arc::new(move || {
                let scope = identity_for_sub.current_user_scope();
                if scope.is_empty() {
                    None
                } else {
                    Some(scope)
                }
            }),
            config.app_version.clone(),
        ));
        let scheduler = PollingScheduler::new();
        {
            let reader = Arc::clone(&reader);
            scheduler.register(
                "entitlements",
                Duration::from_millis(ENTITLEMENTS_INTERVAL_MS),
                move || {
                    let _ = reader.refresh();
                },
            );
        }
        {
            let reader = Arc::clone(&credits);
            scheduler.register("credits", Duration::from_secs(60), move || {
                let _ = reader.refresh();
            });
        }
        Arc::clone(&session_dispatcher).start(&scheduler);
        {
            // Best-effort offline reconcile of a pending identify(): retries the
            // server POST on the scheduler thread (foreground only), never blocking
            // new()/configure(). The tick is a no-op when nothing is pending.
            let identity = Arc::clone(&identity);
            let identify = Arc::clone(&identify);
            scheduler.register("identify_reconcile", Duration::from_secs(30), move || {
                reconcile_identity_impl(&identity, &identify);
            });
        }
        let core = Self {
            _config: Arc::new(config),
            bus,
            identity,
            entitlements: reader,
            credits,
            receipts,
            offerings,
            identify,
            account_tokens,
            sessions,
            session_dispatcher,
            scheduler,
            store: store_for_self,
        };
        // One best-effort reconcile at startup so a pending identify() from a
        // prior offline session syncs without waiting for the first scheduler
        // tick (which also only runs in foreground). Non-blocking: a single
        // short-timeout POST; failure is swallowed and retried by the tick.
        core.reconcile_identity();
        Ok(core)
    }

    /// In-memory constructor for tests — avoids filesystem I/O and test isolation issues.
    /// Not part of the public API; hidden from docs.
    #[doc(hidden)]
    pub fn new_for_test(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        let store = Arc::new(CacheStore::open_in_memory()?);
        Self::from_store(config, store)
    }

    pub fn get_version(&self) -> String {
        SDK_VERSION.to_string()
    }

    pub fn current_user(&self) -> User {
        self.identity.current_user()
    }

    /// Optimistic-local identity link with a best-effort `POST /v1/identify`.
    /// The local write always succeeds (and emits `IdentityChanged`); if the
    /// server call fails (offline/5xx) the row stays `synced: false` and
    /// [`reconcile_identity`](Self::reconcile_identity) retries it later.
    /// Validation errors (empty id) propagate as `Err`.
    pub fn identify(&self, app_user_id: String) -> RovenueResult<()> {
        let changed = self.identity.set_app_user_id(app_user_id.clone())?;
        if changed {
            let rovenue_id = self.identity.rovenue_id();
            match self.identify.identify(&rovenue_id, &app_user_id) {
                Ok(_) => {
                    let _ = self.identity.mark_synced();
                }
                Err(_e) => { /* offline: keep synced=false; reconcile retries */ }
            }
        }
        Ok(())
    }

    /// Retries a pending (`synced == false`) identify against the server.
    /// Best-effort and non-blocking-friendly: a single POST, errors swallowed.
    pub fn reconcile_identity(&self) {
        reconcile_identity_impl(&self.identity, &self.identify);
    }

    /// Logs out the current user: mints a fresh anonymous `rovenue_id`, drops the
    /// `app_user_id`, and clears scope-bound caches so the next user starts clean.
    pub fn log_out(&self) -> RovenueResult<()> {
        self.identity.log_out()?;
        // Clear scope-bound state so the new identity starts clean. The account
        // token and buffered session events are tied to the previous scope.
        self.account_tokens.clear()?;
        self.sessions.clear()?;
        // Entitlements and credits are stateless scope-keyed readers (no in-memory
        // cache); the new rovenue_id scope naturally reads empty, so no clear call.
        Ok(())
    }

    /// Test-only: number of stored app account tokens.
    #[doc(hidden)]
    pub fn test_app_account_token_count(&self) -> i64 {
        self.store.count_app_account_tokens().unwrap_or(0)
    }

    /// Test-only: number of buffered session events.
    #[doc(hidden)]
    pub fn test_session_event_count(&self) -> i64 {
        self.store.list_session_events(usize::MAX).map(|r| r.len() as i64).unwrap_or(0)
    }

    pub fn entitlement(&self, id: String) -> Option<Entitlement> {
        self.entitlements.get(&id).ok().flatten()
    }

    pub fn entitlements_all(&self) -> Vec<Entitlement> {
        self.entitlements.list_all().unwrap_or_default()
    }

    pub fn refresh_entitlements(&self) -> RovenueResult<()> {
        self.entitlements.refresh()
    }

    /// Used by UniFFI FFI (callback interface passes Box).
    pub fn register_observer(&self, obs: Box<dyn Observer>) {
        self.bus.register(Arc::from(obs));
    }

    /// Convenience for Rust-side callers (tests, façades) that hold an Arc.
    pub fn add_observer(&self, obs: Arc<dyn Observer>) {
        self.bus.register(obs);
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.scheduler.set_foreground(foreground);
    }

    pub fn shutdown(&self) {
        self.scheduler.shutdown();
    }

    pub fn credit_balance(&self) -> i64 {
        self.credits.balance().unwrap_or(0)
    }

    pub fn refresh_credits(&self) -> RovenueResult<()> {
        self.credits.refresh()
    }

    pub fn consume_credits(&self, amount: i64, description: Option<String>) -> RovenueResult<i64> {
        if amount <= 0 {
            return Err(RovenueError::Internal);
        }
        let key = IdempotencyKey::new();
        self.credits
            .consume(amount, description.as_deref(), key.as_str())
    }

    pub fn post_apple_receipt(
        &self,
        receipt: String,
        product_id: String,
        app_account_token: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::new();
        let result = self.receipts.post_apple(
            &receipt,
            &scope,
            &product_id,
            key.as_str(),
            app_account_token.as_deref(),
        )?;
        let _ = self.entitlements.refresh();
        let _ = self.credits.refresh();
        Ok(result)
    }

    pub fn post_google_receipt(
        &self,
        receipt: String,
        product_id: String,
        obfuscated_account_id: Option<String>,
        obfuscated_profile_id: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::new();
        let result = self.receipts.post_google(
            &receipt,
            &scope,
            &product_id,
            key.as_str(),
            obfuscated_account_id.as_deref(),
            obfuscated_profile_id.as_deref(),
        )?;
        let _ = self.entitlements.refresh();
        let _ = self.credits.refresh();
        Ok(result)
    }

    pub fn record_session_event(
        &self,
        kind: SessionEventKind,
        occurred_at: String,
        duration_ms: Option<u32>,
    ) -> RovenueResult<()> {
        self.sessions.record(kind, &occurred_at, duration_ms)
    }

    pub fn flush_session_events(&self) -> RovenueResult<u32> {
        self.session_dispatcher.flush_once().map(|n| n as u32)
    }

    pub fn get_or_create_app_account_token(&self) -> RovenueResult<String> {
        let scope = self.identity.current_user_scope();
        self.account_tokens.get_or_create(&scope)
    }

    pub fn get_offerings(&self) -> RovenueResult<CoreOfferings> {
        self.offerings.get_offerings()
    }
}

/// Shared reconcile body used by both `RovenueCore::reconcile_identity` and the
/// scheduler tick. If a pending `app_user_id` exists, attempts one
/// `POST /v1/identify`; on success marks the row synced. All errors are
/// swallowed (best-effort retry).
fn reconcile_identity_impl(identity: &IdentityManager, identify: &IdentifyClient) {
    if let Some(app_user_id) = identity.pending_app_user_id() {
        let rovenue_id = identity.rovenue_id();
        if identify.identify(&rovenue_id, &app_user_id).is_ok() {
            let _ = identity.mark_synced();
        }
    }
}

fn default_db_path() -> RovenueResult<PathBuf> {
    let mut p = dirs_path().ok_or(RovenueError::Storage)?;
    p.push("rovenue.db");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|_| RovenueError::Storage)?;
    }
    Ok(p)
}

#[cfg(target_os = "macos")]
fn dirs_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push("Library/Application Support/Rovenue");
    Some(p)
}

#[cfg(all(
    target_os = "linux",
    not(any(target_os = "android", target_os = "ios"))
))]
fn dirs_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| {
                let mut p = PathBuf::from(h);
                p.push(".local/share");
                p
            })
        })?;
    let mut p = base;
    p.push("rovenue");
    Some(p)
}

#[cfg(any(target_os = "windows", target_os = "android", target_os = "ios"))]
fn dirs_path() -> Option<PathBuf> {
    std::env::var_os("TMPDIR")
        .or_else(|| std::env::var_os("TEMP"))
        .map(|p| {
            let mut pb = PathBuf::from(p);
            pb.push("rovenue");
            pb
        })
}
