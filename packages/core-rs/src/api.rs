use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::attributes::buffer::AttributeBuffer;
use crate::attributes::dispatcher::AttributeDispatcher;
use crate::cache::{CacheStore, ExposureRepo, FunnelRepo};
use crate::config::Config;
use crate::entitlements::{Entitlement, EntitlementReader};
use crate::error::{RovenueError, RovenueResult};
use crate::events::{EventsClient, PaywallEventQueue};
use crate::exposure::ExposureTracker;
use crate::funnel::{
    ClaimInstallParams, FunnelClaimBus, FunnelClaimListener, FunnelClaimResult, FunnelClient,
};
use crate::identify::IdentifyClient;
use crate::identity::{IdentityManager, User};
use crate::logging::{LogLevel, LogSink, Logger};
use crate::observer::{Observer, ObserverBus};
use crate::offerings::{CoreOfferings, OfferingsClient};
use crate::placements::{parse_fallback_file, CorePaywall, CorePresentedContext, PlacementsClient};
use crate::polling::PollingScheduler;
use crate::purchases::{AppleOfferSignature, PurchasesClient};
use crate::receipts::types::ReceiptPostOutcome;
use crate::receipts::{ReceiptClient, ReceiptResult};
use crate::remote_config::{ExperimentAssignment, RemoteConfigReader};
use crate::sessions::{AccountTokenStore, SessionBuffer, SessionDispatcher, SessionEventKind};
use crate::time::{Clock, SystemClock};
use crate::transport::http_client::HttpClient;
use crate::transport::idempotency::IdempotencyKey;
use crate::version::SDK_VERSION;
use crate::virtual_currencies::VirtualCurrencyReader;

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
    pub(crate) logger: Arc<Logger>,
    bus: Arc<ObserverBus>,
    identity: Arc<IdentityManager>,
    entitlements: Arc<EntitlementReader>,
    virtual_currencies: Arc<VirtualCurrencyReader>,
    receipts: Arc<ReceiptClient>,
    purchases: Arc<PurchasesClient>,
    events: Arc<EventsClient>,
    paywall_events: Arc<PaywallEventQueue>,
    funnel: Arc<FunnelClient>,
    funnel_bus: Arc<FunnelClaimBus>,
    offerings: Arc<OfferingsClient>,
    placements: Arc<PlacementsClient>,
    /// Last paywall-attribution snapshot returned by `get_paywall`, stamped
    /// onto the next receipt POST's `presentedContext` and cleared on a
    /// successful post. Session-ish state, alongside `identity`/`sessions`.
    presented_context: Mutex<Option<CorePresentedContext>>,
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
            return Err(RovenueError::InvalidApiKey());
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
        let logger = Arc::new(Logger::new(config.log_level));
        let bus = Arc::new(ObserverBus::default().with_logger(Arc::clone(&logger)));
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
                .with_max_attempts(http_max_attempts)
                .with_logger(Arc::clone(&logger)),
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
        let purchases = Arc::new(PurchasesClient::new(Arc::clone(&http)));
        let events = Arc::new(EventsClient::new(Arc::clone(&http)));
        let paywall_events = Arc::new(
            PaywallEventQueue::new(Arc::clone(&store), Arc::clone(&events))
                .with_logger(Arc::clone(&logger)),
        );
        let funnel = Arc::new(FunnelClient::new(Arc::clone(&http)));
        let funnel_bus = Arc::new(FunnelClaimBus::default().with_logger(Arc::clone(&logger)));
        let offerings = Arc::new(
            OfferingsClient::new(Arc::clone(&http), Arc::clone(&store))
                .with_clock(Arc::clone(&clock)),
        );
        let placements = Arc::new(
            PlacementsClient::new(Arc::clone(&http), Arc::clone(&store))
                .with_clock(Arc::clone(&clock))
                .with_logger(Arc::clone(&logger)),
        );
        let remote_config = Arc::new(
            RemoteConfigReader::new(Arc::clone(&http), Arc::clone(&store), Arc::clone(&identity))
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
                // Wire identity is the stable rovenue_id (server resolves it as a
                // rovenueId); never the app_user_id, which would orphan the row.
                let id = identity_for_sub.rovenue_id();
                if id.is_empty() {
                    None
                } else {
                    Some(id)
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
                // Wire identity is the stable rovenue_id (server resolves it as a
                // rovenueId); never the app_user_id, which would orphan the row.
                let id = identity_for_attr.rovenue_id();
                if id.is_empty() {
                    None
                } else {
                    Some(id)
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
            logger,
            bus,
            identity,
            entitlements: reader,
            virtual_currencies,
            receipts,
            purchases,
            events,
            paywall_events,
            funnel,
            funnel_bus,
            offerings,
            placements,
            presented_context: Mutex::new(None),
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
        //
        // The paywall-event queue is different: it has its own single-flight
        // guard (no shared mutable state with anything else), so a configure-
        // time drain trigger is safe and covers events left behind by a
        // process kill during a previous session (spec D4). Non-blocking —
        // `trigger_drain` spawns a background thread.
        core.paywall_events.trigger_drain();
        Ok(core)
    }

    /// In-memory constructor for tests — avoids filesystem I/O and test isolation issues.
    /// Not part of the public API; hidden from docs.
    #[doc(hidden)]
    pub fn new_for_test(config: Config) -> RovenueResult<Self> {
        if config.api_key.trim().is_empty() {
            return Err(RovenueError::InvalidApiKey());
        }
        let config = config.normalized()?;
        let store = Arc::new(CacheStore::open_in_memory()?);
        Self::from_store_with_http_max_attempts(config, store, 1)
    }

    /// Structured operation log. Emits `op` field always; caller appends `kind` on error.
    /// Never pass PII (app_user_id, email, receipt) as `message` or in `extra`.
    fn log_op(&self, level: LogLevel, message: &str, op: &str, extra: &[(&str, &str)]) {
        let message = message.to_string();
        let op = op.to_string();
        let extra: Vec<(String, String)> = extra
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        self.logger.log(
            level,
            move || message,
            move || {
                let mut f = std::collections::HashMap::new();
                f.insert("op".to_string(), op);
                for (k, v) in extra {
                    f.insert(k, v);
                }
                f
            },
        );
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
        self.log_op(LogLevel::Info, "identify", "identify", &[]);
        let result = (|| -> RovenueResult<()> {
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
        })();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "identify ok", "identify", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "identify failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "identify",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Retries a pending (`synced == false`) identify against the server.
    /// Best-effort and non-blocking-friendly: a single POST, errors swallowed.
    pub fn reconcile_identity(&self) {
        reconcile_identity_impl(&self.identity, &self.identify);
    }

    /// Logs out the current user: mints a fresh anonymous `rovenue_id`, drops the
    /// `app_user_id`, and clears scope-bound caches so the next user starts clean.
    pub fn log_out(&self) -> RovenueResult<()> {
        self.log_op(LogLevel::Info, "log_out", "log_out", &[]);
        let result = (|| -> RovenueResult<()> {
            self.identity.log_out()?;
            // Clear scope-bound state so the new identity starts clean. The account
            // token and buffered session events are tied to the previous scope.
            self.account_tokens.clear()?;
            self.sessions.clear()?;
            self.attributes.clear()?;
            // Entitlements and credits are stateless scope-keyed readers (no in-memory
            // cache); the new rovenue_id scope naturally reads empty, so no clear call.
            // Drop any pending paywall-attribution snapshot: it was drawn for the
            // outgoing identity's subscriber id and must not attribute a
            // purchase made under the fresh anonymous rovenue_id.
            self.clear_presented_context();
            Ok(())
        })();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "log_out ok", "log_out", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "log_out failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "log_out",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Test-only: number of stored app account tokens.
    #[doc(hidden)]
    pub fn test_app_account_token_count(&self) -> i64 {
        self.store.count_app_account_tokens().unwrap_or(0)
    }

    /// Test-only: number of buffered session events.
    #[doc(hidden)]
    pub fn test_session_event_count(&self) -> i64 {
        self.store
            .list_session_events(usize::MAX)
            .map(|r| r.len() as i64)
            .unwrap_or(0)
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
        self.log_op(
            LogLevel::Info,
            "refresh_entitlements",
            "refresh_entitlements",
            &[],
        );
        let result = self.entitlements.refresh();
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "refresh_entitlements ok",
                "refresh_entitlements",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "refresh_entitlements failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "refresh_entitlements",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Used by UniFFI FFI (callback interface passes Box).
    pub fn register_observer(&self, obs: Box<dyn Observer>) {
        self.bus.register(Arc::from(obs));
    }

    /// Convenience for Rust-side callers (tests, façades) that hold an Arc.
    pub fn add_observer(&self, obs: Arc<dyn Observer>) {
        self.bus.register(obs);
    }

    /// Register a log sink to receive structured log records from this core instance.
    pub fn register_log_sink(&self, sink: Box<dyn LogSink>) {
        self.logger.set_sink(Arc::from(sink));
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.scheduler.set_foreground(foreground);
        if foreground {
            // Refresh now instead of waiting out the remaining poll interval.
            self.scheduler.reset_cadence();
            // Spec D4 drain trigger. Non-blocking — spawns a background
            // thread, so a caller invoking this synchronously from e.g.
            // applicationDidBecomeActive never stalls on network I/O.
            self.paywall_events.trigger_drain();
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
        self.log_op(
            LogLevel::Info,
            "refresh_virtual_currencies",
            "refresh_virtual_currencies",
            &[],
        );
        let result = self.virtual_currencies.refresh();
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "refresh_virtual_currencies ok",
                "refresh_virtual_currencies",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "refresh_virtual_currencies failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "refresh_virtual_currencies",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    pub fn post_apple_receipt(
        &self,
        receipt: String,
        product_id: String,
        app_account_token: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        self.log_op(
            LogLevel::Info,
            "post_apple_receipt",
            "post_apple_receipt",
            &[],
        );
        let result = (|| -> RovenueResult<ReceiptResult> {
            // Wire identity (server resolves the body appUserId as a rovenueId);
            // `scope` namespaces the local receipt cache write in finish_receipt.
            let scope = self.identity.current_user_scope();
            let wire_id = self.identity.rovenue_id();
            let key = IdempotencyKey::for_receipt("apple", &receipt);
            // Peek (don't clear yet) the last paywall-attribution snapshot —
            // only cleared once the POST actually succeeds.
            let presented_context = self.peek_presented_context();
            let outcome = self.receipts.post_apple(
                &receipt,
                &wire_id,
                &product_id,
                key.as_str(),
                app_account_token.as_deref(),
                presented_context.as_ref(),
            )?;
            if presented_context.is_some() {
                self.clear_presented_context();
            }
            Ok(self.finish_receipt(&scope, outcome))
        })();
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "post_apple_receipt ok",
                "post_apple_receipt",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "post_apple_receipt failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "post_apple_receipt",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    pub fn post_google_receipt(
        &self,
        receipt: String,
        product_id: String,
        obfuscated_account_id: Option<String>,
        obfuscated_profile_id: Option<String>,
    ) -> RovenueResult<ReceiptResult> {
        self.log_op(
            LogLevel::Info,
            "post_google_receipt",
            "post_google_receipt",
            &[],
        );
        let result = (|| -> RovenueResult<ReceiptResult> {
            // Wire identity (server resolves the body appUserId as a rovenueId);
            // `scope` namespaces the local receipt cache write in finish_receipt.
            let scope = self.identity.current_user_scope();
            let wire_id = self.identity.rovenue_id();
            let key = IdempotencyKey::for_receipt("google", &receipt);
            // Peek (don't clear yet) the last paywall-attribution snapshot —
            // only cleared once the POST actually succeeds.
            let presented_context = self.peek_presented_context();
            let outcome = self.receipts.post_google(
                &receipt,
                &wire_id,
                &product_id,
                key.as_str(),
                obfuscated_account_id.as_deref(),
                obfuscated_profile_id.as_deref(),
                presented_context.as_ref(),
            )?;
            if presented_context.is_some() {
                self.clear_presented_context();
            }
            Ok(self.finish_receipt(&scope, outcome))
        })();
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "post_google_receipt ok",
                "post_google_receipt",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "post_google_receipt failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "post_google_receipt",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Request an Apple promotional-offer signature from the backend.
    ///
    /// Project-scoped (authenticated by the project API key only — no
    /// subscriber scope or idempotency key is needed).
    pub fn get_apple_offer_signature(
        &self,
        product_id: String,
        offer_id: String,
        app_account_token: Option<String>,
    ) -> RovenueResult<AppleOfferSignature> {
        self.log_op(
            LogLevel::Info,
            "get_apple_offer_signature",
            "get_apple_offer_signature",
            &[],
        );
        let result = self.purchases.get_apple_offer_signature(
            &product_id,
            &offer_id,
            app_account_token.as_deref(),
        );
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "get_apple_offer_signature ok",
                "get_apple_offer_signature",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "get_apple_offer_signature failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "get_apple_offer_signature",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Emit a generic event to `POST /v1/events` (fire-and-forget, 3-retry).
    /// `envelope_json` is the camelCase wire envelope built by the façade.
    /// When the envelope omits `subscriberId`, it is filled from the current
    /// scope (`app_user_id` if identified, else the anonymous `rovenue_id`).
    pub fn track(&self, envelope_json: String) -> RovenueResult<()> {
        self.log_op(LogLevel::Info, "track", "track", &[]);
        let result = (|| -> RovenueResult<()> {
            let mut envelope: crate::events::EventEnvelope =
                serde_json::from_str(&envelope_json)
                    .map_err(|_| RovenueError::InvalidArgument())?;

            if !is_plausible_iso8601(&envelope.occurred_at) {
                return Err(RovenueError::InvalidArgument());
            }

            // Stamp the wire version and a stable event id (the latter only when
            // the caller didn't supply one) so retries reuse the same id and
            // downstream fan-out can dedupe.
            envelope.version = Some(crate::events::EVENT_WIRE_VERSION);
            if envelope.event_id.is_none() {
                envelope.event_id = Some(format!("evt_{}", cuid2::create_id()));
            }

            // Attribute events to the stable rovenue_id device key — the server
            // resolves the subscriberId as a rovenueId, so the app_user_id would
            // route to an orphan row.
            let wire_id = self.identity.rovenue_id();
            let wire_opt = if wire_id.is_empty() {
                None
            } else {
                Some(wire_id)
            };

            if envelope.subscriber_id.is_none() {
                envelope.subscriber_id = wire_opt.clone();
            }

            self.events.post(&envelope, wire_opt.as_deref())
        })();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "track ok", "track", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "track failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "track",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Enqueue a `paywall_*` event (`paywall_view` / `paywall_close`) into
    /// the durable, process-kill-safe queue (spec D4) instead of posting
    /// inline like `track()` does. `envelope_json` is the camelCase wire
    /// envelope built by the façade (`logPaywallShown`/`logPaywallClosed`
    /// and the renderers' auto-emit calls). Rejected as `InvalidArgument`
    /// when `envelope_json` doesn't parse or `eventType` doesn't start with
    /// `paywall_` — this is intentionally not a general-purpose queued
    /// `track()`.
    ///
    /// Stamps `version`/`eventId`/`subscriberId` here (exactly like
    /// `track()`) BEFORE persisting, so the queued envelope carries a
    /// stable identity and dedupe key that survives a `log_out()` between
    /// enqueue and drain. Bounded at 100 entries (drop-oldest); drained on
    /// configure/foreground/after this call (see `PaywallEventQueue`).
    pub fn enqueue_paywall_event(&self, envelope_json: String) -> RovenueResult<()> {
        self.log_op(
            LogLevel::Info,
            "enqueue_paywall_event",
            "enqueue_paywall_event",
            &[],
        );
        let result = (|| -> RovenueResult<()> {
            let mut envelope: crate::events::EventEnvelope =
                serde_json::from_str(&envelope_json)
                    .map_err(|_| RovenueError::InvalidArgument())?;

            if !is_plausible_iso8601(&envelope.occurred_at) {
                return Err(RovenueError::InvalidArgument());
            }

            envelope.version = Some(crate::events::EVENT_WIRE_VERSION);
            if envelope.event_id.is_none() {
                envelope.event_id = Some(format!("evt_{}", cuid2::create_id()));
            }

            // Attribute to the stable rovenue_id device key — the server
            // resolves the subscriberId as a rovenueId, so the app_user_id
            // would route to an orphan row (mirrors track()).
            let wire_id = self.identity.rovenue_id();
            if envelope.subscriber_id.is_none() && !wire_id.is_empty() {
                envelope.subscriber_id = Some(wire_id);
            }

            let stamped = serde_json::to_string(&envelope).map_err(|_| RovenueError::Internal())?;
            self.paywall_events.enqueue(&stamped)
        })();
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "enqueue_paywall_event ok",
                "enqueue_paywall_event",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "enqueue_paywall_event failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "enqueue_paywall_event",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Persisted per-install id (`inst_<cuid2>`), generated on first access.
    pub fn install_id(&self) -> String {
        let now = self.clock.now_unix_ms();
        FunnelRepo::new(&self.store)
            .get_or_create_install_id(now)
            .unwrap_or_default()
    }

    /// True iff this install has already successfully claimed a funnel token
    /// (funnel_claim_state == "claimed"). Used by the SDK's first-launch
    /// orchestration to run the resolution chain at most once per install.
    pub fn has_resolved_funnel_claim(&self) -> bool {
        let install_id = self.install_id();
        FunnelRepo::new(&self.store)
            .claim_state(&install_id)
            .ok()
            .flatten()
            .as_deref()
            == Some("claimed")
    }

    /// Register a listener fired whenever a funnel claim resolves (direct call
    /// now; automatic orchestration later). Mirrors `register_observer`.
    pub fn register_funnel_claim_listener(&self, listener: Box<dyn FunnelClaimListener>) {
        self.funnel_bus.register(Arc::from(listener));
    }

    /// Claim a known funnel token. On success refreshes entitlements (the claim
    /// response carries none), records `claimed` state, fires the callback.
    pub fn claim_funnel_token(&self, token: String) -> RovenueResult<FunnelClaimResult> {
        self.log_op(
            LogLevel::Info,
            "claim_funnel_token",
            "claim_funnel_token",
            &[],
        );
        let anon_id = self.identity.rovenue_id();
        let inner = self.funnel.claim_funnel_token(&token, &anon_id);
        let result = self.finish_claim(inner);
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "claim_funnel_token ok",
                "claim_funnel_token",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "claim_funnel_token failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "claim_funnel_token",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Recover a token via `claim-install` then claim it. `None` when no match.
    pub fn claim_install(
        &self,
        params: ClaimInstallParams,
    ) -> RovenueResult<Option<FunnelClaimResult>> {
        self.log_op(LogLevel::Info, "claim_install", "claim_install", &[]);
        let result = (|| -> RovenueResult<Option<FunnelClaimResult>> {
            let install_id = self.install_id();
            match self.funnel.claim_install(&params, &install_id)? {
                Some(token) => Ok(Some(self.claim_funnel_token(token)?)),
                None => Ok(None),
            }
        })();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "claim_install ok", "claim_install", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "claim_install failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "claim_install",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Kick off the email magic-link path. Resolution completes later when the
    /// link returns to the app (deep link → claim_funnel_token).
    pub fn claim_via_email(&self, email: String) -> RovenueResult<()> {
        self.log_op(LogLevel::Info, "claim_via_email", "claim_via_email", &[]);
        let result: RovenueResult<()> = {
            let install_id = self.install_id();
            self.funnel.claim_via_email(&email, &install_id)
        };
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "claim_via_email ok", "claim_via_email", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "claim_via_email failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "claim_via_email",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
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

    /// Read (without clearing) the paywall-attribution snapshot stamped by
    /// the last `get_paywall()` call, if any.
    fn peek_presented_context(&self) -> Option<CorePresentedContext> {
        self.presented_context
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// Drop the stored paywall-attribution snapshot — called once it has
    /// actually been attached to a successful receipt POST, so it isn't
    /// re-sent on a later, unrelated purchase.
    fn clear_presented_context(&self) {
        if let Ok(mut guard) = self.presented_context.lock() {
            *guard = None;
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
        let balances: std::collections::BTreeMap<String, i64> = outcome
            .virtual_currencies
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
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
        self.log_op(LogLevel::Info, "set_attributes", "set_attributes", &[]);
        let result = (|| -> RovenueResult<()> {
            for (key, value) in attributes.iter() {
                self.attributes.set(key, value.as_deref())?;
            }
            Ok(())
        })();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "set_attributes ok", "set_attributes", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "set_attributes failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "set_attributes",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
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
        self.log_op(
            LogLevel::Info,
            "get_or_create_app_account_token",
            "get_or_create_app_account_token",
            &[],
        );
        let result: RovenueResult<String> = {
            let scope = self.identity.current_user_scope();
            self.account_tokens.get_or_create(&scope)
        };
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "get_or_create_app_account_token ok",
                "get_or_create_app_account_token",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "get_or_create_app_account_token failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "get_or_create_app_account_token",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    pub fn get_offerings(&self) -> RovenueResult<CoreOfferings> {
        self.log_op(LogLevel::Info, "get_offerings", "get_offerings", &[]);
        let result = self.offerings.get_offerings();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "get_offerings ok", "get_offerings", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "get_offerings failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "get_offerings",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Resolve `GET /v1/placements/{placement_id}?locale=` into the paywall
    /// (drawing an experiment variant when applicable) the caller should
    /// render. `Ok(None)` means the placement resolved to nothing — NOT an
    /// error (see `PlacementsClient::get_paywall`). On success, the returned
    /// paywall's attribution snapshot is stamped into core state so the next
    /// receipt POST carries it as `presentedContext`.
    pub fn get_paywall(
        &self,
        placement_id: String,
        locale: Option<String>,
    ) -> RovenueResult<Option<CorePaywall>> {
        self.log_op(LogLevel::Info, "get_paywall", "get_paywall", &[]);
        let result = (|| -> RovenueResult<Option<CorePaywall>> {
            // Wire identity (the server resolves it as a rovenueId; also the
            // stable bucketing key for the client-side experiment draw).
            let wire_id = self.identity.rovenue_id();
            let paywall =
                self.placements
                    .get_paywall(&placement_id, locale.as_deref(), &wire_id)?;
            if let Some(ctx) = paywall.as_ref().and_then(|p| p.presented_context.clone()) {
                if let Ok(mut guard) = self.presented_context.lock() {
                    *guard = Some(ctx);
                }
            }
            Ok(paywall)
        })();
        match &result {
            Ok(_) => self.log_op(LogLevel::Info, "get_paywall ok", "get_paywall", &[]),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "get_paywall failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "get_paywall",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    /// Parse a spec D1 bundled fallback-placements file (once, replacing any
    /// previously-loaded set) so `get_paywall` can serve placements offline
    /// when both network and disk cache miss. Returns the count of entries
    /// actually loaded — an individual entry that fails to decode is
    /// skipped (logged), not fatal; a wholesale-malformed file, or one whose
    /// `formatVersion` isn't literal `1`, is a distinct `InvalidArgument`
    /// error surfaced immediately (see `placements::fallback::parse_fallback_file`).
    pub fn set_fallback_placements(&self, json: String) -> RovenueResult<u32> {
        self.log_op(
            LogLevel::Info,
            "set_fallback_placements",
            "set_fallback_placements",
            &[],
        );
        let result = (|| -> RovenueResult<u32> {
            let entries = parse_fallback_file(&json, Some(&self.logger))?;
            let count = entries.len() as u32;
            self.placements.set_fallback(entries);
            Ok(count)
        })();
        match &result {
            Ok(count) => self.log_op(
                LogLevel::Info,
                "set_fallback_placements ok",
                "set_fallback_placements",
                &[("count", &count.to_string())],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "set_fallback_placements failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "set_fallback_placements",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
    }

    // ---- Remote Config (feature flags + experiment assignments) ----

    /// Force an immediate Remote Config fetch from `/v1/config`.
    pub fn refresh_remote_config(&self) -> RovenueResult<()> {
        self.log_op(
            LogLevel::Info,
            "refresh_remote_config",
            "refresh_remote_config",
            &[],
        );
        let result = self.remote_config.refresh();
        match &result {
            Ok(_) => self.log_op(
                LogLevel::Info,
                "refresh_remote_config ok",
                "refresh_remote_config",
                &[],
            ),
            Err(e) => self.log_op(
                LogLevel::Error,
                &format!(
                    "refresh_remote_config failed: {}",
                    crate::logging::redact::redact_message(&e.message)
                ),
                "refresh_remote_config",
                &[("kind", &format!("{:?}", e.kind))],
            ),
        }
        result
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
    let mut p = dirs_path().ok_or(RovenueError::Storage())?;
    p.push("rovenue.db");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|_| RovenueError::Storage())?;
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
    use crate::error::ErrorKind;
    use crate::funnel::{ClaimInstallParams, FunnelClaimListener, FunnelClaimResult};
    use std::sync::{Arc, Mutex};

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
        let _m_claim = server
            .mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber_id":"sub_9","entitlements":[],"funnel_answers":{"q1":1}}}"#,
            )
            .create();
        // claim_funnel_token triggers refresh_entitlements (a GET).
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect_at_least(1)
            .create();

        let core = make_core(&server.url());
        let seen = Arc::new(Mutex::new(Vec::new()));
        core.register_funnel_claim_listener(Box::new(CapturingListener(Arc::clone(&seen))));

        let r = core
            .claim_funnel_token("a_token_value".into())
            .expect("claim ok");
        assert_eq!(r.subscriber_id, "sub_9");
        assert_eq!(r.funnel_answers_json, r#"{"q1":1}"#);
        assert_eq!(seen.lock().unwrap().len(), 1, "callback fired once");
        assert_eq!(seen.lock().unwrap()[0].subscriber_id, "sub_9");
    }

    #[test]
    #[serial_test::serial]
    fn claim_install_chains_to_token_claim() {
        let mut server = mockito::Server::new();
        let _m_install = server
            .mock("POST", "/v1/sdk/claim-install")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"token":"recovered"}}"#)
            .create();
        let _m_claim = server
            .mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber_id":"sub_i","entitlements":[],"funnel_answers":{}}}"#,
            )
            .create();
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect_at_least(1)
            .create();

        let core = make_core(&server.url());
        let seen = Arc::new(Mutex::new(Vec::new()));
        core.register_funnel_claim_listener(Box::new(CapturingListener(Arc::clone(&seen))));
        let params = ClaimInstallParams {
            platform: "android".into(),
            locale: "en-US".into(),
            timezone: "UTC".into(),
            screen_dims: "390x844".into(),
            device_model: None,
            install_referrer: Some("rovenue_funnel_token=recovered".into()),
        };
        let out = core.claim_install(params).expect("claim_install ok");
        assert_eq!(out.unwrap().subscriber_id, "sub_i");
        assert_eq!(seen.lock().unwrap().len(), 1, "callback fired exactly once");
    }

    #[test]
    #[serial_test::serial]
    fn claim_install_returns_none_on_404() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("POST", "/v1/sdk/claim-install")
            .with_status(404)
            .create();
        let core = make_core(&server.url());
        let params = ClaimInstallParams {
            platform: "ios".into(),
            locale: "en-US".into(),
            timezone: "UTC".into(),
            screen_dims: "390x844".into(),
            device_model: None,
            install_referrer: None,
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

    #[test]
    #[serial_test::serial]
    fn has_resolved_funnel_claim_false_on_fresh_install() {
        let core = make_core("http://127.0.0.1:1");
        assert!(!core.has_resolved_funnel_claim());
    }

    #[test]
    #[serial_test::serial]
    fn has_resolved_funnel_claim_true_after_successful_claim() {
        let mut server = mockito::Server::new();
        let _m_claim = server
            .mock("POST", "/v1/subscribers/claim-funnel-token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriber_id":"sub_1","entitlements":[],"funnel_answers":{}}}"#,
            )
            .create();
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .expect_at_least(1)
            .create();

        let core = make_core(&server.url());
        assert!(!core.has_resolved_funnel_claim());
        core.claim_funnel_token("a_token_value".into())
            .expect("claim ok");
        assert!(core.has_resolved_funnel_claim(), "claimed state → resolved");
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
        let _m_ent = server.mock("GET", "/v1/me/entitlements").expect(0).create();
        let _m_cred = server.mock("GET", "/v1/me/credits").expect(0).create();

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
    fn post_apple_receipt_sends_rovenue_id_not_app_user_id_after_identify() {
        // Regression (P0): after identify("user_42"), the receipt body's
        // appUserId field (which the server resolves as a rovenueId) MUST carry
        // the stable rovenue_id device key — not the app_user_id. Otherwise the
        // purchase attaches to an orphan subscriber row instead of the device's.
        let mut server = mockito::Server::new();
        let _m_identify = server
            .mock("POST", "/v1/identify")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriberId":"sub_x","appUserId":"user_42","transferred":false}}"#,
            )
            .create();

        let core = make_core(&server.url());
        core.identify("user_42".into()).unwrap();
        let rovenue_id = core.current_user().rovenue_id;
        assert_ne!(rovenue_id, "user_42");

        let m_receipt = server
            .mock("POST", "/v1/receipts/apple")
            .match_body(mockito::Matcher::PartialJsonString(format!(
                r#"{{"appUserId":"{rovenue_id}"}}"#
            )))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"subscriber":{"id":"sub_1","appUserId":"user_42"}}}"#)
            .expect(1)
            .create();
        let _m_ent = server
            .mock("GET", "/v1/me/entitlements")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"entitlements":{}}}"#)
            .create();

        core.post_apple_receipt("jws_token".into(), "pro_monthly".into(), None)
            .expect("receipt ok");

        m_receipt.assert();
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
            .with_body(r#"{"data":{"subscriber":{"id":"sub_2","appUserId":"u2"}}}"#)
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
    fn track_auto_fills_subscriber_with_rovenue_id_after_identify() {
        // Regression (P0): even after identify("user_42"), the event's wire
        // subscriberId MUST be the stable rovenue_id device key — NOT the
        // app_user_id. The server resolves subscriberId as a rovenueId, so the
        // app_user_id would attribute the event to an orphan row.
        let mut server = mockito::Server::new();
        let _m_identify = server
            .mock("POST", "/v1/identify")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"data":{"subscriberId":"sub_x","appUserId":"user_42","transferred":false}}"#,
            )
            .create();

        let core = make_core(&server.url());
        // identify() writes app_user_id locally even if its own POST fails.
        core.identify("user_42".into()).unwrap();
        let rovenue_id = core.current_user().rovenue_id;
        assert_ne!(rovenue_id, "user_42");

        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::PartialJsonString(format!(
                r#"{{"eventType":"purchase","subscriberId":"{rovenue_id}"}}"#
            )))
            .with_status(202)
            .create();

        core.track(r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z"}"#.into())
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
            .with_body(
                r#"{"data":{"subscriberId":"sub_x","appUserId":"user_42","transferred":false}}"#,
            )
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
        assert!(err.kind == ErrorKind::InvalidArgument);
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
        assert!(err.kind == ErrorKind::InvalidArgument);
    }

    /// Regression guard for the façade `logPaywallShown` path (Task 9): a
    /// `paywallContext` key on the envelope MUST survive the
    /// deserialize-into-`EventEnvelope`-then-reserialize round trip inside
    /// `track()`. Before `EventEnvelope` gained a `paywall_context` field,
    /// serde silently dropped this unknown key — the POST body would have
    /// been missing `paywallContext` entirely despite the caller supplying
    /// it, defeating the whole point of `logPaywallShown`.
    #[test]
    #[serial_test::serial]
    fn track_forwards_paywall_context() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"eventType":"paywall_view","paywallContext":{"paywallId":"pw_1","placementId":"plc_1","placementRevision":3,"variantId":"var_a","experimentKey":"exp_1"}}"#.into(),
            ))
            .with_status(202)
            .create();

        let core = make_core(&server.url());
        core.track(
            r#"{"eventType":"paywall_view","occurredAt":"2026-06-20T10:00:00Z","eventId":"evt_stable","paywallContext":{"paywallId":"pw_1","placementId":"plc_1","placementRevision":3,"variantId":"var_a","experimentKey":"exp_1"}}"#.into(),
        )
        .expect("track ok");

        m.assert();
    }

    // -----------------------------------------------------------
    // enqueue_paywall_event (spec D4 — durable paywall_* queue). The full
    // drain-discipline matrix (2xx delete / 5xx retain+stop / 4xx poison /
    // bound-100 / single-flight / kill-safety) is covered directly against
    // `PaywallEventQueue` in events/queue.rs; these tests only cover the
    // RovenueCore-level wiring (validation, stamping, end-to-end drain).
    // -----------------------------------------------------------

    #[test]
    #[serial_test::serial]
    fn enqueue_paywall_event_rejects_malformed_json() {
        let core = make_core("http://127.0.0.1:1");
        let err = core.enqueue_paywall_event("not json".into()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidArgument);
    }

    #[test]
    #[serial_test::serial]
    fn enqueue_paywall_event_rejects_non_paywall_event_types() {
        let core = make_core("http://127.0.0.1:1");
        let err = core
            .enqueue_paywall_event(
                r#"{"eventType":"purchase","occurredAt":"2026-06-20T10:00:00Z"}"#.into(),
            )
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidArgument);
    }

    #[test]
    #[serial_test::serial]
    fn enqueue_paywall_event_rejects_malformed_occurred_at() {
        let core = make_core("http://127.0.0.1:1");
        let err = core
            .enqueue_paywall_event(
                r#"{"eventType":"paywall_view","occurredAt":"not-a-date"}"#.into(),
            )
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidArgument);
    }

    /// End-to-end: enqueue_paywall_event stamps version/eventId/subscriberId
    /// (mirroring track()) BEFORE persisting, then the configure-time /
    /// post-enqueue drain trigger actually posts it to /v1/events — proves
    /// the whole RovenueCore -> PaywallEventQueue -> EventsClient wiring,
    /// not just the queue in isolation.
    #[test]
    #[serial_test::serial]
    fn enqueue_paywall_event_stamps_and_drains_end_to_end() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("POST", "/v1/events")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::PartialJsonString(
                    r#"{"version":1,"eventType":"paywall_close"}"#.into(),
                ),
                mockito::Matcher::Regex(r#""eventId":"evt_"#.into()),
                mockito::Matcher::Regex(r#""subscriberId":"rov_"#.into()),
            ]))
            .with_status(202)
            .create();

        let core = make_core(&server.url());
        core.enqueue_paywall_event(
            r#"{"eventType":"paywall_close","occurredAt":"2026-06-20T10:00:00Z","paywallContext":{"paywallId":"pw_1","placementId":"plc_1","placementRevision":3}}"#.into(),
        )
        .expect("enqueue ok");

        let mut drained = false;
        for _ in 0..50 {
            if m.matched() {
                drained = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(drained, "the background drain must post the queued event");
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

    #[test]
    fn identify_logs_op_at_info_with_op_field() {
        use crate::logging::{LogLevel, LogRecord, LogSink};
        use std::sync::Mutex as StdMutex;
        struct Collector(Arc<StdMutex<Vec<LogRecord>>>);
        impl LogSink for Collector {
            fn on_log(&self, r: LogRecord) {
                self.0.lock().unwrap().push(r);
            }
        }
        let mut cfg = Config::new("pk_test".to_string(), String::new()).unwrap();
        cfg.log_level = LogLevel::Info;
        let core = RovenueCore::new_for_test(cfg).unwrap();
        let recs = Arc::new(StdMutex::new(Vec::new()));
        core.register_log_sink(Box::new(Collector(recs.clone())));
        let _ = core.identify("user_should_not_appear".to_string());
        let got = recs.lock().unwrap();
        // An "identify" op record exists at info level...
        assert!(
            got.iter()
                .any(|r| r.fields.get("op").map(|o| o == "identify").unwrap_or(false)),
            "expected an op=identify record, got: {:?}",
            got.iter()
                .map(|r| (&r.message, &r.fields))
                .collect::<Vec<_>>()
        );
        // ...and the app_user_id never appears in any message or field.
        for r in got.iter() {
            assert!(
                !r.message.contains("user_should_not_appear"),
                "PII leaked in message: {}",
                r.message
            );
            assert!(
                r.fields
                    .values()
                    .all(|v| !v.contains("user_should_not_appear")),
                "PII leaked in fields: {:?}",
                r.fields
            );
        }
    }

    #[test]
    fn register_log_sink_receives_records() {
        use crate::logging::{LogRecord, LogSink};
        use std::sync::Mutex as StdMutex;
        struct Collector(Arc<StdMutex<Vec<LogRecord>>>);
        impl LogSink for Collector {
            fn on_log(&self, r: LogRecord) {
                self.0.lock().unwrap().push(r);
            }
        }
        let cfg = Config::new("pk_test".to_string(), String::new()).unwrap();
        let core = RovenueCore::new_for_test(cfg).unwrap();
        let recs = Arc::new(StdMutex::new(Vec::new()));
        core.register_log_sink(Box::new(Collector(recs.clone())));
        // Assert the sink wiring is live by emitting a warn directly.
        core.logger.warn("test-warn");
        assert!(recs
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.message == "test-warn"));
    }
}
