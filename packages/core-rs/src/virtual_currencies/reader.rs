use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::cache::{CacheStore, VirtualCurrencyRepo};
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::types::VcBalancesWire;

pub struct VirtualCurrencyReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    http: Option<Arc<HttpClient>>,
    bus: Option<Arc<ObserverBus>>,
    clock: Option<Arc<dyn Clock>>,
    last_refresh_ms: AtomicU64,
    refreshing: AtomicBool,
}

impl VirtualCurrencyReader {
    pub fn new(store: Arc<CacheStore>, identity: Arc<IdentityManager>) -> Self {
        Self {
            store,
            identity,
            http: None,
            bus: None,
            clock: None,
            last_refresh_ms: AtomicU64::new(0),
            refreshing: AtomicBool::new(false),
        }
    }
    pub fn with_http(mut self, http: Arc<HttpClient>) -> Self {
        self.http = Some(http);
        self
    }
    pub fn with_observer_bus(mut self, bus: Arc<ObserverBus>) -> Self {
        self.bus = Some(bus);
        self
    }
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = Some(clock);
        self
    }

    fn repo(&self) -> VirtualCurrencyRepo {
        VirtualCurrencyRepo::new(Arc::clone(&self.store))
    }

    /// All cached balances for the current user scope (code → balance).
    pub fn balances(&self) -> BTreeMap<String, i64> {
        let scope = self.identity.current_user_scope();
        self.repo().get_all(&scope).unwrap_or_default()
    }

    /// One currency's cached balance, or 0 when absent.
    pub fn balance(&self, code: &str) -> i64 {
        let scope = self.identity.current_user_scope();
        self.repo().get(&scope, code).ok().flatten().unwrap_or(0)
    }

    /// GET /v1/virtual-currencies/me → replace the cached balance set.
    pub fn refresh(&self) -> RovenueResult<()> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal())?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal())?;
        // Cache namespaced by scope; wire identity is always the stable
        // rovenue_id (server resolves the header as a rovenueId).
        let scope = self.identity.current_user_scope();
        let wire_id = self.identity.rovenue_id();

        let resp = http.get_json::<ApiEnvelope<VcBalancesWire>>(
            HttpRequest::new("/v1/virtual-currencies/me").user_scope(&wire_id),
        )?;
        let body = resp.body.ok_or(RovenueError::Internal())?;
        let balances: BTreeMap<String, i64> = body.data.balances.into_iter().collect();
        self.set_balances(&scope, &balances, clock.now_unix_ms())
    }

    /// Persist a balance set and emit `VirtualCurrenciesChanged` if it changed.
    /// Stamps freshness so background coalescing (`maybe_refresh_async`) settles.
    pub fn set_balances(
        &self,
        scope: &str,
        balances: &BTreeMap<String, i64>,
        now_ms: u64,
    ) -> RovenueResult<()> {
        let repo = self.repo();
        let changed = repo
            .get_all(scope)
            .map(|prev| &prev != balances)
            .unwrap_or(true);
        repo.upsert_all(scope, balances, now_ms)?;
        if changed {
            if let Some(bus) = &self.bus {
                bus.emit(ChangeEvent::VirtualCurrenciesChanged);
            }
        }
        self.last_refresh_ms.store(now_ms, Ordering::Relaxed);
        Ok(())
    }

    fn is_stale(&self, now: u64, staleness_ms: u64) -> bool {
        now.saturating_sub(self.last_refresh_ms.load(Ordering::Relaxed)) > staleness_ms
    }

    pub fn maybe_refresh_async(self: &std::sync::Arc<Self>, staleness_ms: u64) {
        let now = match &self.clock {
            Some(c) => c.now_unix_ms(),
            None => return,
        };
        if !self.is_stale(now, staleness_ms) {
            return;
        }
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let this = std::sync::Arc::clone(self);
        std::thread::spawn(move || {
            // Clear the coalesce flag even if refresh() unwinds, so a panicking
            // observer callback can't permanently disable background refresh.
            struct ClearOnDrop<'a>(&'a std::sync::atomic::AtomicBool);
            impl Drop for ClearOnDrop<'_> {
                fn drop(&mut self) {
                    self.0.store(false, std::sync::atomic::Ordering::Release);
                }
            }
            let _guard = ClearOnDrop(&this.refreshing);
            let _ = this.refresh();
        });
    }
}
