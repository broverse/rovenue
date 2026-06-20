use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::attributes::buffer::AttributeBuffer;
use crate::attributes::dispatcher::AttributeDispatcher;
use crate::cache::{CacheStore, ExposureRepo, FunnelRepo};
use crate::funnel::{ClaimInstallParams, FunnelClaimBus, FunnelClaimListener, FunnelClaimResult, FunnelClient};
use crate::config::Config;
use crate::virtual_currencies::VirtualCurrencyReader;
use crate::entitlements::{Entitlement, EntitlementReader};
use crate::events::EventsClient;
use crate::error::{RovenueError, RovenueResult};
use crate::exposure::ExposureTracker;
use crate::identify::IdentifyClient;
use crate::identity::{IdentityManager, User};
use crate::observer::{Observer, ObserverBus};
use crate::offerings::{CoreOfferings, OfferingsClient};
use crate::polling::PollingScheduler;
use crate::receipts::{ReceiptClient, ReceiptResult};
use crate::receipts::types::ReceiptPostOutcome;
use crate::remote_config::{ExperimentAssignment, RemoteConfigReader};
use crate::sessions::{AccountTokenStore, SessionBuffer, SessionDispatcher, SessionEventKind};
use crate::time::{Clock, SystemClock};
use crate::transport::http_client::HttpClient;
use crate::transport::idempotency::IdempotencyKey;
use crate::version::SDK_VERSION;

const ENTITLEMENTS_INTERVAL_MS: u64 = 30_000;
const REMOTE_CONFIG_INTERVAL_MS: u64 = 60_000;
const STALENESS_MS: u64 = 60_000;

/// Conservative sanity check for an RFC3339 / ISO-8601 UTC timestamp.
/// Rejects clearly-malformed values ("", "tomorrow", "not-a-date") without
/// risking false negatives on valid timestamps the server would accept — it
/// only requires a 4-digit year, a `T` separator, and a `:` in the time part.
fn is_plausible_iso8601(s: &str) -> bool {
    s.len() >= 16
        && s.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && s.contains('T')
        && s.contains(':')
}

pub struct RovenueCore {
    _config: Arc<Config>,
    bus: Arc<ObserverBus>,
    identity: Arc<IdentityManager>,
    entitlements: Arc<EntitlementReader>,
    virtual_currencies: Arc<VirtualCurrencyReader>,
    receipts: Arc<ReceiptClient>,
    events: Arc<EventsClient>,
    funnel: Arc<FunnelClient>,
    funnel_bus: Arc<FunnelClaimBus>,
    offerings: Arc<OfferingsClient>,
    remote_config: Arc<RemoteConfigReader>,
    exposure: Arc<ExposureTracker>,
    identify: Arc<IdentifyClient>,
    account_tokens: Arc<AccountTokenStore>,
    sessions: Arc<SessionBuffer>,
    session_dispatcher: Arc<SessionDispatcher>,
    attributes: Arc<AttributeBuffer>,
    attribute_dispatcher: Arc<AttributeDispatcher>,
    scheduler: PollingScheduler,
    store: Arc<CacheStore>,
    clock: Arc<dyn Clock>,
}

impl RovenueCore {
    pub fn new(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        let config = config.normalized()?;
        let store = Arc::new(CacheStore::open(&default_db_path()?)?);
        Self::from_store(config, store)
    }

    fn from_store(config: Config, store: Arc<CacheStore>) -> RovenueResult<Self> {
        Self::from_store_with_http_max_attempts(config, store, 3)
    }

    /// Like `from_store` but allows overriding the HTTP client's `max_attempts`.
    /// Used by `new_for_test` (passes `1`) so that retryable 5xx responses fail
    /// immediately in tests rather than sleeping through exponential backoff.
    fn from_store_with_http_max_attempts(
        config: Config,
        store: Arc<CacheStore>,
        http_max_attempts: u32,
    ) -> RovenueResult<Self> {
        let bus = Arc::new(ObserverBus::default());
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store_for_self = Arc::clone(&store);
        let identity = Arc::new(IdentityManager::new(
            Arc::clone(&store),
            Arc::clone(&bus),
            Arc::clone(&clock),
        ));
        let http = Arc::new(
            HttpClient::new(config.base_url.clone(), config.api_key.clone())
                .with_platform(config.platform.clone())
                .with_environment(config.environment.clone())
                .with_max_attempts(http_max_attempts),
        );
        let reader = Arc::new(
            EntitlementReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let virtual_currencies = Arc::new(
            VirtualCurrencyReader::new(Arc::clone(&store), Arc::clone(&identity))
                .with_http(Arc::clone(&http))
                .with_observer_bus(Arc::clone(&bus))
                .with_clock(Arc::clone(&clock)),
        );
        let receipts = Arc::new(ReceiptClient::new(Arc::clone(&http)));
        let events = Arc::new(EventsClient::new(Arc::clone(&http)));
        let funnel = Arc::new(FunnelClient::new(Arc::clone(&http)));
        let funnel_bus = Arc::new(FunnelClaimBus::default());
        let offerings = Arc::new(
            OfferingsClient::new(Arc::clone(&http), Arc::clone(&store))
                .with_clock(Arc::clone(&clock)),
        );
        let remote_config = Arc::new(
            RemoteConfigReader::new(
                Arc::clone(&http),
                Arc::clone(&store),
                Arc::clone(&identity),
            )
            .with_observer_bus(Arc::clone(&bus))
            .with_clock(Arc::clone(&clock)),
        );
        let exposure = ExposureTracker::new(
            ExposureRepo::new(Arc::clone(&store)),
            Some(Arc::clone(&http)),
            Some(Arc::clone(&clock)),
            Arc::clone(&identity),
        );
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
        let attributes = Arc::new(AttributeBuffer::new(Arc::clone(&store)));
        let identity_for_attr = Arc::clone(&identity);
        let attribute_dispatcher = Arc::new(AttributeDispatcher::new(
            Arc::clone(&attributes),
            Arc::clone(&http),
            Box::new(move || {
                let scope = identity_for_attr.current_user_scope();
                if scope.is_empty() {
                    None
                } else {
                    Some(scope)
                }
            }),
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
            let reader = Arc::clone(&virtual_currencies);
            scheduler.register("virtual_currencies", Duration::from_secs(60), move || {
                let _ = reader.refresh();
            });
        }
        {
            let reader = Arc::clone(&remote_config);
            scheduler.register(
                "remote_config",
                Duration::from_millis(REMOTE_CONFIG_INTERVAL_MS),
                move || {
                    let _ = reader.refresh();
                },
            );
        }
        Arc::clone(&session_dispatcher).start(&scheduler);
        Arc::clone(&attribute_dispatcher).start(&scheduler);
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
            virtual_currencies,
            receipts,
            events,
            funnel,
            funnel_bus,
            offerings,
            remote_config,
            exposure,
            identify,
            account_tokens,
            sessions,
            session_dispatcher,
            attributes,
            attribute_dispatcher,
            scheduler,
            store: store_for_self,
            clock: Arc::clone(&clock),
        };
        // No synchronous startup reconcile: it would block configure() on the
        // network, and spawning it on a thread races a concurrent identify()
        // (both observe the same pending state before mark_synced → double
        // POST). The foreground "identify_reconcile" scheduler tick registered
        // above is the sole retry path for a pending offline identify().
        Ok(core)
    }

    /// In-memory constructor for tests — avoids filesystem I/O and test isolation issues.
    /// Not part of the public API; hidden from docs.
    #[doc(hidden)]
    pub fn new_for_test(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey);
        }
        let config = config.normalized()?;
        let store = Arc::new(CacheStore::open_in_memory()?);
        Self::from_store_with_http_max_attempts(config, store, 1)
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
                    // Guarded by the posted id so a concurrent identify() of a
                    // different id isn't falsely marked synced.
                    let _ = self.identity.mark_synced(&app_user_id);
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
        self.attributes.clear()?;
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
        let out = self.entitlements.get(&id).ok().flatten();
        self.entitlements.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn entitlements_all(&self) -> Vec<Entitlement> {
        let out = self.entitlements.list_all().unwrap_or_default();
        self.entitlements.maybe_refresh_async(STALENESS_MS);
        out
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
        if foreground {
            // Refresh now instead of waiting out the remaining poll interval.
            self.scheduler.reset_cadence();
        }
    }

    pub fn shutdown(&self) {
        self.scheduler.shutdown();
    }

    pub fn virtual_currency_balances(&self) -> std::collections::HashMap<String, i64> {
        let out = self.virtual_currencies.balances().into_iter().collect();
        self.virtual_currencies.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn virtual_currency(&self, code: String) -> i64 {
        let out = self.virtual_currencies.balance(&code);
        self.virtual_currencies.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn refresh_virtual_currencies(&self) -> RovenueResult<()> {
        self.virtual_currencies.refresh()
    }

    pub fn post_apple_receipt(
        &self,
        receipt: String,
        product_id: String,
        app_account_token: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::for_receipt("apple", &receipt);
        let outcome = self.receipts.post_apple(
            &receipt,
            &scope,
            &product_id,
            key.as_str(),
            app_account_token.as_deref(),
        )?;
        Ok(self.finish_receipt(&scope, outcome))
    }

    pub fn post_google_receipt(
        &self,
        receipt: String,
        product_id: String,
        obfuscated_account_id: Option<String>,
        obfuscated_profile_id: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        let scope = self.identity.current_user_scope();
        let key = IdempotencyKey::for_receipt("google", &receipt);
        let outcome = self.receipts.post_google(
            &receipt,
            &scope,
            &product_id,
            key.as_str(),
            obfuscated_account_id.as_deref(),
            obfuscated_profile_id.as_deref(),
        )?;
        Ok(self.finish_receipt(&scope, outcome))
    }

    /// Emit a generic event to `POST /v1/events` (fire-and-forget, 3-retry).
    /// `envelope_json` is the camelCase wire envelope built by the façade.
    /// When the envelope omits `subscriberId`, it is filled from the current
    /// scope (`app_user_id` if identified, else the anonymous `rovenue_id`).
    pub fn track(&self, envelope_json: String) -> RovenueResult<()> {
        let mut envelope: crate::events::EventEnvelope =
            serde_json::from_str(&envelope_json).map_err(|_| RovenueError::InvalidArgument)?;

        if !is_plausible_iso8601(&envelope.occurred_at) {
            return Err(RovenueError::InvalidArgument);
        }

        // Stamp the wire version and a stable event id (the latter only when
        // the caller didn't supply one) so retries reuse the same id and
        // downstream fan-out can dedupe.
        envelope.version = Some(crate::events::EVENT_WIRE_VERSION);
        if envelope.event_id.is_none() {
            envelope.event_id = Some(format!("evt_{}", cuid2::create_id()));
        }

        let scope = self.identity.current_user_scope();
        let scope_opt = if scope.is_empty() { None } else { Some(scope) };

        if envelope.subscriber_id.is_none() {
            envelope.subscriber_id = scope_opt.clone();
        }

        self.events.post(&envelope, scope_opt.as_deref())
    }

    /// Persisted per-install id (`inst_<cuid2>`), generated on first access.
    pub fn install_id(&self) -> String {
        let now = self.clock.now_unix_ms();
        FunnelRepo::new(&self.store)
            .get_or_create_install_id(now)
            .unwrap_or_default()
    }

    /// Register a listener fired whenever a funnel claim resolves (direct call
    /// now; automatic orchestration later). Mirrors `register_observer`.
    pub fn register_funnel_claim_listener(&self, listener: Box<dyn FunnelClaimListener>) {
        self.funnel_bus.register(Arc::from(listener));
    }

    /// Claim a known funnel token. On success refreshes entitlements (the claim
    /// response carries none), records `claimed` state, fires the callback.
    pub fn claim_funnel_token(&self, token: String) -> RovenueResult<FunnelClaimResult> {
        let anon_id = self.identity.rovenue_id();
        let result = self.funnel.claim_funnel_token(&token, &anon_id);
        self.finish_claim(result)
    }

    /// Recover a token via `claim-install` then claim it. `None` when no match.
    pub fn claim_install(
        &self,
        params: ClaimInstallParams,
    ) -> RovenueResult<Option<FunnelClaimResult>> {
        let install_id = self.install_id();
        match self.funnel.claim_install(&params, &install_id)? {
            Some(token) => Ok(Some(self.claim_funnel_token(token)?)),
            None => Ok(None),
        }
    }

    /// Kick off the email magic-link path. Resolution completes later when the
    /// link returns to the app (deep link → claim_funnel_token).
    pub fn claim_via_email(&self, email: String) -> RovenueResult<()> {
        let install_id = self.install_id();
        self.funnel.claim_via_email(&email, &install_id)
    }

    /// Shared tail for a token claim: on Ok, refresh entitlements, record state,
    /// fire the callback; on Err, record `failed`.
    fn finish_claim(
        &self,
        result: RovenueResult<FunnelClaimResult>,
    ) -> RovenueResult<FunnelClaimResult> {
        let now = self.clock.now_unix_ms();
        let install_id = self.install_id();
        let repo = FunnelRepo::new(&self.store);
        match result {
            Ok(r) => {
                let _ = self.refresh_entitlements();
                let _ = repo.set_claim_state(&install_id, "claimed", Some(&r.subscriber_id), now);
                self.funnel_bus.emit(r.clone());
                Ok(r)
            }
            Err(e) => {
                let _ = repo.set_claim_state(&install_id, "failed", None, now);
                Err(e)
            }
        }
    }

    /// Hydrate entitlement + VC caches from a receipt POST response and
    /// build the FFI result — no follow-up GETs. Falls back to a GET refresh
    /// only when an older server omitted `access` entirely.
    fn finish_receipt(&self, scope: &str, outcome: ReceiptPostOutcome) -> ReceiptResult {
        let now = self.clock.now_unix_ms();
        match outcome.access {
            Some(access) => {
                let _ = self.entitlements.hydrate(scope, access, now);
            }
            None => {
                let _ = self.entitlements.refresh();
            }
        }
        let balances: std::collections::BTreeMap<String, i64> =
            outcome.virtual_currencies.iter().map(|(k, v)| (k.clone(), *v)).collect();
        let _ = self.virtual_currencies.set_balances(scope, &balances, now);
        ReceiptResult {
            subscriber_id: outcome.subscriber_id,
            app_user_id: outcome.app_user_id,
            virtual_currencies: outcome.virtual_currencies,
            entitlements: self.entitlements.list_all().unwrap_or_default(),
        }
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

    /// Queue a batch of attribute mutations. `None` value deletes the key.
    /// Written locally immediately; flushed to the server in the background
    /// (30s tick / foreground / manual flush_attributes).
    pub fn set_attributes(
        &self,
        attributes: std::collections::HashMap<String, Option<String>>,
    ) -> RovenueResult<()> {
        for (key, value) in attributes.iter() {
            self.attributes.set(key, value.as_deref())?;
        }
        Ok(())
    }

    /// Force an immediate flush. Returns the number of mutations sent.
    pub fn flush_attributes(&self) -> RovenueResult<u32> {
        self.attribute_dispatcher.flush_once().map(|n| n as u32)
    }

    /// Test-only: number of queued attribute mutations.
    #[doc(hidden)]
    pub fn test_attribute_queue_len(&self) -> i64 {
        self.store
            .list_attribute_mutations(usize::MAX)
            .map(|r| r.len() as i64)
            .unwrap_or(0)
    }

    pub fn get_or_create_app_account_token(&self) -> RovenueResult<String> {
        let scope = self.identity.current_user_scope();
        self.account_tokens.get_or_create(&scope)
    }

    pub fn get_offerings(&self) -> RovenueResult<CoreOfferings> {
        self.offerings.get_offerings()
    }

    // ---- Remote Config (feature flags + experiment assignments) ----

    /// Force an immediate Remote Config fetch from `/v1/config`.
    pub fn refresh_remote_config(&self) -> RovenueResult<()> {
        self.remote_config.refresh()
    }

    pub fn remote_config_bool(&self, key: String, fallback: bool) -> bool {
        let out = self.remote_config.bool(&key, fallback);
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn remote_config_string(&self, key: String, fallback: String) -> String {
        let out = self.remote_config.string(&key, fallback);
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn remote_config_int(&self, key: String, fallback: i64) -> i64 {
        let out = self.remote_config.int(&key, fallback);
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn remote_config_double(&self, key: String, fallback: f64) -> f64 {
        let out = self.remote_config.double(&key, fallback);
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    /// Raw JSON string for any present flag (object/array/primitive), or `None`
    /// when the key is absent. Façades parse this for structured flag values.
    pub fn remote_config_json(&self, key: String) -> Option<String> {
        let out = self.remote_config.json(&key);
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn remote_config_keys(&self) -> Vec<String> {
        let out = self.remote_config.keys();
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    pub fn experiment(&self, key: String) -> Option<ExperimentAssignment> {
        let out = self.remote_config.experiment(&key);
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        if let Some(ref a) = out {
            self.exposure.maybe_track(a);
        }
        out
    }

    pub fn experiments_all(&self) -> Vec<ExperimentAssignment> {
        let out = self.remote_config.experiments_all();
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
    }

    /// Whole Remote Config payload as a JSON string (`{ flags, experiments }`),
    /// for façades backing a reactive synchronous hook surface.
    pub fn remote_config_all_json(&self) -> String {
        let out = self.remote_config.all_json();
        self.remote_config.maybe_refresh_async(STALENESS_MS);
        out
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
            // Guard by the id we posted: if a concurrent identify() changed the
            // pending id meanwhile, don't mark the newer one synced.
            let _ = identity.mark_synced(&app_user_id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::sync::{Arc, Mutex};
    use crate::funnel::{ClaimInstallParams, FunnelClaimListener, FunnelClaimResult};

    struct CapturingListener(Arc<Mutex<Vec<FunnelClaimResult>>>);
    impl FunnelClaimListener for CapturingListener {
        fn on_funnel_claim_resolved(&self, result: FunnelClaimResult) {
            self.0.lock().unwrap().push(result);
        }
    }

    #[test]
    #[serial_test::serial]
    fn claim_funnel_token_refreshes_records_and_fires_callback() {
        let mut server = mockito::Server::new();
        let _m_claim = server.mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_9","entitlements":[],"funnel_answers":{"q1":1}}}"#)
            .create();
        // claim_funnel_token triggers refresh_entitlements (a GET).
        let _m_ent = server.mock("GET", "/v1/me/entitlements")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#).expect_at_least(1).create();

        let core = make_core(&server.url());
        let seen = Arc::new(Mutex::new(Vec::new()));
        core.register_funnel_claim_listener(Box::new(CapturingListener(Arc::clone(&seen))));

        let r = core.claim_funnel_token("a_token_value".into()).expect("claim ok");
        assert_eq!(r.subscriber_id, "sub_9");
        assert_eq!(r.funnel_answers_json, r#"{"q1":1}"#);
        assert_eq!(seen.lock().unwrap().len(), 1, "callback fired once");
        assert_eq!(seen.lock().unwrap()[0].subscriber_id, "sub_9");
    }

    #[test]
    #[serial_test::serial]
    fn claim_install_chains_to_token_claim() {
        let mut server = mockito::Server::new();
        let _m_install = server.mock("POST", "/v1/sdk/claim-install")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"token":"recovered"}}"#).create();
        let _m_claim = server.mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber_id":"sub_i","entitlements":[],"funnel_answers":{}}}"#).create();
        let _m_ent = server.mock("GET", "/v1/me/entitlements")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#).expect_at_least(1).create();

        let core = make_core(&server.url());
        let params = ClaimInstallParams {
            platform: "android".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None,
            install_referrer: Some("rovenue_funnel_token=recovered".into()),
        };
        let out = core.claim_install(params).expect("claim_install ok");
        assert_eq!(out.unwrap().subscriber_id, "sub_i");
    }

    #[test]
    #[serial_test::serial]
    fn claim_install_returns_none_on_404() {
        let mut server = mockito::Server::new();
        let _m = server.mock("POST", "/v1/sdk/claim-install").with_status(404).create();
        let core = make_core(&server.url());
        let params = ClaimInstallParams {
            platform: "ios".into(), locale: "en-US".into(), timezone: "UTC".into(),
            screen_dims: "390x844".into(), device_model: None, install_referrer: None,
        };
        assert!(core.claim_install(params).expect("ok").is_none());
    }

    #[test]
    #[serial_test::serial]
    fn install_id_is_stable() {
        let core = make_core("http://127.0.0.1:1");
        let a = core.install_id();
        let b = core.install_id();
        assert!(a.starts_with("inst_"));
        assert_eq!(a, b);
    }

    fn make_core(base_url: &str) -> RovenueCore {
        let config = Config::new("pk_test_abc".into(), base_url.to_string()).unwrap();
        RovenueCore::new_for_test(config).unwrap()
    }

    #[test]
    #[serial_test::serial]
    fn post_apple_receipt_hydrates_without_followup_get() {
        let mut server = mockito::Server::new();

        // The receipt POST — returns subscriber + VC balances + access map
        let _m_receipt = server
            .mock("POST", "/v1/receipts/apple")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"u1"},
                    "virtualCurrencyBalances":{"gold":7},
                    "access":{"pro":{"isActive":true,"expiresDate":null,
                              "store":"APP_STORE","productIdentifier":"pro_monthly"}}}}"#,
            )
            .create();

        // Ensure no GET calls to entitlements or credits are made
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .expect(0)
            .create();
        let _m_cred = server
            .mock("GET", "/v1/me/credits")
            .expect(0)
            .create();

        let core = make_core(&server.url());
        let result = core
            .post_apple_receipt("jws_token".into(), "pro_monthly".into(), None)
            .expect("receipt ok");

        assert_eq!(result.virtual_currencies.get("gold"), Some(&7));
        assert_eq!(core.virtual_currency("gold".into()), 7);
        assert_eq!(result.entitlements.len(), 1);
        assert_eq!(result.entitlements[0].id, "pro");
        assert!(result.entitlements[0].is_active);

        _m_ent.assert();
        _m_cred.assert();
    }

    #[test]
    #[serial_test::serial]
    fn post_apple_receipt_falls_back_to_get_when_access_absent() {
        let mut server = mockito::Server::new();

        // Receipt POST without `access` field (pre-0.7 server)
        let _m_receipt = server
            .mock("POST", "/v1/receipts/apple")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber":{"id":"sub_2","appUserId":"u2"}}}"#,
            )
            .create();

        // Exactly one GET to entitlements should fire as fallback
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect(1)
            .create();

        let core = make_core(&server.url());
        let result = core
            .post_apple_receipt("jws_token_2".into(), "basic".into(), None)
            .expect("receipt ok");

        assert_eq!(result.subscriber_id, "sub_2");
        assert_eq!(result.entitlements.len(), 0);

        _m_ent.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_auto_fills_subscriber_from_scope() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"eventType":"purchase","subscriberId":"user_42"}"#.into(),
            ))
            .with_status(202)
            .create();

        let _m_identify = server
            .mock("POST", "/v1/identify")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriberId":"sub_x","appUserId":"user_42","transferred":false}}"#)
            .create();

        let core = make_core(&server.url());
        // identify() writes app_user_id locally even if its own POST fails.
        core.identify("user_42".into()).unwrap();

        core.track(
            r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z"}"#.into(),
        )
        .expect("track ok");

        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_preserves_explicit_subscriber_id() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"eventType":"purchase","subscriberId":"explicit_sub"}"#.into(),
            ))
            .with_status(202)
            .create();

        // identify() POSTs /v1/identify; mock it so the scope is actually set
        // to the identified user_42 (otherwise identify fails silently and the
        // scope stays the anonymous rovenue_id, and the test exercises nothing).
        let _m_identify = server
            .mock("POST", "/v1/identify")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriberId":"sub_x","appUserId":"user_42","transferred":false}}"#)
            .create();

        let core = make_core(&server.url());
        core.identify("user_42".into()).unwrap();

        // Explicit subscriberId must win over the identified scope.
        core.track(
            r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","subscriberId":"explicit_sub"}"#.into(),
        )
        .expect("track ok");

        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_rejects_malformed_json() {
        let core = make_core("http://127.0.0.1:1");
        let err = core.track("not json".into()).unwrap_err();
        assert!(matches!(err, RovenueError::InvalidArgument));
    }

    #[test]
    #[serial_test::serial]
    fn track_sets_wire_version_and_generates_event_id() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::PartialJsonString(
                    r#"{"version":1,"eventType":"purchase"}"#.into(),
                ),
                // eventId is generated; assert presence + prefix, not value.
                mockito::Matcher::Regex(r#""eventId":"evt_"#.into()),
            ]))
            .with_status(202)
            .create();

        let core = make_core(&server.url());
        core.track(r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z"}"#.into())
            .expect("track ok");

        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_preserves_explicit_event_id() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"eventId":"evt_custom","version":1}"#.into(),
            ))
            .with_status(202)
            .create();

        let core = make_core(&server.url());
        core.track(
            r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z","eventId":"evt_custom"}"#.into(),
        )
        .expect("track ok");

        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn track_rejects_malformed_occurred_at() {
        let core = make_core("http://127.0.0.1:1");
        let err = core
            .track(r#"{"eventType":"purchase","occurredAt":"not-a-date"}"#.into())
            .unwrap_err();
        assert!(matches!(err, RovenueError::InvalidArgument));
    }

    #[test]
    #[serial_test::serial]
    fn stale_read_triggers_single_coalesced_refresh() {
        let mut server = mockito::Server::new();

        // A freshly built core has last_refresh_ms == 0 so every read is stale.
        // Five rapid calls must coalesce into exactly one GET.
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect(1)
            .create();

        let core = make_core(&server.url());
        for _ in 0..5 {
            let _ = core.entitlements_all();
        }
        // Allow the background thread to complete its single refresh.
        std::thread::sleep(std::time::Duration::from_millis(300));
        _m_ent.assert();
    }
}
