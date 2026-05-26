use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::cache::CacheStore;
use crate::config::Config;
use crate::credits::CreditReader;
use crate::entitlements::{Entitlement, EntitlementReader};
use crate::error::{RovenueError, RovenueResult};
use crate::identity::{IdentityManager, User};
use crate::observer::{Observer, ObserverBus};
use crate::polling::PollingScheduler;
use crate::receipts::{ReceiptClient, ReceiptResult};
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
    scheduler: PollingScheduler,
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
        Ok(Self {
            _config: Arc::new(config),
            bus,
            identity,
            entitlements: reader,
            credits,
            receipts,
            scheduler,
        })
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

    pub fn identify(&self, known_user_id: String) -> RovenueResult<()> {
        self.identity.identify(known_user_id)
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
        self.credits.consume(amount, description.as_deref(), key.as_str())
    }

    pub fn post_apple_receipt(
        &self,
        receipt: String,
        product_id: String,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::new();
        let result = self.receipts.post_apple(&receipt, &scope, &product_id, key.as_str())?;
        let _ = self.entitlements.refresh();
        let _ = self.credits.refresh();
        Ok(result)
    }

    pub fn post_google_receipt(
        &self,
        receipt: String,
        product_id: String,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::new();
        let result = self.receipts.post_google(&receipt, &scope, &product_id, key.as_str())?;
        let _ = self.entitlements.refresh();
        let _ = self.credits.refresh();
        Ok(result)
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
