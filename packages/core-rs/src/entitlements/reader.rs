use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::cache::entitlements::EntitlementsRepo;
use crate::cache::etag::EtagRepo;
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::api::map_to_rows;
use super::types::{Entitlement, EntitlementWire, EntitlementsResponse};

const RESOURCE: &str = "entitlements";

/// True when cached data is older than `staleness_ms`. `last == 0` (never
/// refreshed, e.g. cold start) is always stale.
pub(crate) fn is_stale(now: u64, last: u64, staleness_ms: u64) -> bool {
    now.saturating_sub(last) > staleness_ms
}

pub struct EntitlementReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    http: Option<Arc<HttpClient>>,
    bus: Option<Arc<ObserverBus>>,
    clock: Option<Arc<dyn Clock>>,
    last_refresh_ms: AtomicU64,
    refreshing: AtomicBool,
}

impl EntitlementReader {
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

    pub fn get(&self, id: &str) -> RovenueResult<Option<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo.get(&scope, id)?.map(row_to_entitlement))
    }

    pub fn list_all(&self) -> RovenueResult<Vec<Entitlement>> {
        let scope = self.identity.current_user_scope();
        let repo = EntitlementsRepo::new(&self.store);
        Ok(repo
            .list(&scope)?
            .into_iter()
            .map(row_to_entitlement)
            .collect())
    }

    pub fn refresh(&self) -> RovenueResult<()> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal())?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal())?;

        let scope = self.identity.current_user_scope();
        let etag_repo = EtagRepo::new(&self.store);
        let prior_etag = etag_repo.get(RESOURCE)?;

        let mut req = HttpRequest::new("/v1/me/entitlements").user_scope(&scope);
        if let Some(ref e) = prior_etag {
            req = req.etag(e);
        }

        let resp = http.get_json::<ApiEnvelope<EntitlementsResponse>>(req)?;

        if resp.status == 304 {
            self.last_refresh_ms
                .store(clock.now_unix_ms(), Ordering::Relaxed);
            return Ok(());
        }

        let body = resp.body.ok_or(RovenueError::Internal())?;
        let now = clock.now_unix_ms();
        let rows = map_to_rows(body.data.entitlements, now);
        EntitlementsRepo::new(&self.store).upsert_many(&scope, &rows)?;
        if let Some(etag) = resp.etag {
            etag_repo.put(RESOURCE, &etag, now)?;
        }
        self.last_refresh_ms.store(now, Ordering::Relaxed);
        if let Some(bus) = &self.bus {
            bus.emit(ChangeEvent::EntitlementsChanged);
        }
        Ok(())
    }

    /// Write entitlements straight from an in-memory access map (e.g. a receipt
    /// POST response) — no network. Stamps freshness and emits the observer.
    pub fn hydrate(
        &self,
        scope: &str,
        map: HashMap<String, EntitlementWire>,
        now: u64,
    ) -> RovenueResult<()> {
        let rows = map_to_rows(map, now);
        EntitlementsRepo::new(&self.store).upsert_many(scope, &rows)?;
        self.last_refresh_ms.store(now, Ordering::Relaxed);
        if let Some(bus) = &self.bus {
            bus.emit(ChangeEvent::EntitlementsChanged);
        }
        Ok(())
    }

    /// Non-blocking stale-while-revalidate trigger. Returns immediately; if the
    /// cache is stale and no refresh is in flight, spawns one background refresh
    /// (coalesced via `refreshing`) that emits the observer on completion.
    pub fn maybe_refresh_async(self: &std::sync::Arc<Self>, staleness_ms: u64) {
        let now = match &self.clock {
            Some(c) => c.now_unix_ms(),
            None => return,
        };
        if !is_stale(
            now,
            self.last_refresh_ms.load(Ordering::Relaxed),
            staleness_ms,
        ) {
            return;
        }
        if self
            .refreshing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return; // a refresh is already running — coalesce
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

fn row_to_entitlement(r: crate::cache::entitlements::EntitlementRow) -> Entitlement {
    Entitlement {
        id: r.entitlement_id,
        is_active: r.is_active,
        product_identifier: r.product_identifier,
        store: r.store,
        expires_iso: r.expires_iso,
    }
}

#[cfg(test)]
mod stale_tests {
    use super::is_stale;
    #[test]
    fn staleness_decision() {
        assert!(is_stale(100_000, 0, 60_000));
        assert!(is_stale(100_000, 30_000, 60_000));
        assert!(!is_stale(100_000, 50_000, 60_000));
        assert!(!is_stale(100_000, 100_000, 60_000));
    }
}

#[cfg(test)]
mod panic_safety_tests {
    use super::EntitlementReader;
    use crate::cache::CacheStore;
    use crate::identity::IdentityManager;
    use crate::observer::{ChangeEvent, Observer, ObserverBus};
    use crate::time::{Clock, SystemClock};
    use crate::transport::http_client::HttpClient;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    /// Observer whose callback unwinds — simulates a host (Swift/Kotlin) closure
    /// panicking across the FFI boundary during `emit`.
    struct PanickingObserver;
    impl Observer for PanickingObserver {
        fn on_change(&self, _event: ChangeEvent) {
            panic!("boom from observer");
        }
    }

    /// Regression: `maybe_refresh_async` spawns a background `refresh()`. If that
    /// refresh unwinds (e.g. a panicking observer in `emit`), the `refreshing`
    /// coalesce flag must STILL be cleared — otherwise a single panic would
    /// permanently disable all future background refreshes. Guarded by an
    /// RAII `ClearOnDrop` in the spawned thread.
    #[test]
    fn maybe_refresh_async_clears_flag_even_if_refresh_panics() {
        let mut server = mockito::Server::new();
        // refresh() GETs entitlements, upserts, stamps freshness, THEN emit()s —
        // so the spawned thread reaches the panicking observer and unwinds.
        let _m = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .create();

        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let bus = Arc::new(ObserverBus::default());
        bus.register(Arc::new(PanickingObserver));
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let identity = Arc::new(IdentityManager::new(
            Arc::clone(&store),
            Arc::clone(&bus),
            Arc::clone(&clock),
        ));
        let http = Arc::new(HttpClient::new(server.url(), "pk_test".to_string()));
        let reader = Arc::new(
            EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(http)
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(clock),
        );

        // last_refresh_ms == 0 → stale → spawns a refresh that will unwind in emit().
        reader.maybe_refresh_async(60_000);

        // Let the background thread run, unwind, and drop the ClearOnDrop guard.
        std::thread::sleep(std::time::Duration::from_millis(500));

        assert!(
            !reader.refreshing.load(Ordering::SeqCst),
            "refreshing flag must be cleared even when the background refresh() panics"
        );
        // Directly prove the coalesce slot is reclaimable (not wedged `true`).
        assert!(
            reader
                .refreshing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "flag must be claimable again after a panicking refresh"
        );
    }
}
