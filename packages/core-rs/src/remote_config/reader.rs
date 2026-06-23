use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use serde_json::Value;

use crate::cache::remote_config::RemoteConfigCacheRepo;
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::{Clock, SystemClock};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::types::{ConfigResponse, ExperimentAssignment};

/// Cache key for the (subscriber-scoped) Remote Config payload.
const REMOTE_CONFIG_RESOURCE: &str = "remote_config";

#[derive(Default)]
struct State {
    flags: serde_json::Map<String, Value>,
    experiments: HashMap<String, ExperimentAssignment>,
}

struct Inner {
    http: Arc<HttpClient>,
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    clock: Arc<dyn Clock>,
    bus: Option<Arc<ObserverBus>>,
    state: RwLock<State>,
    last_refresh_ms: AtomicU64,
    refreshing: AtomicBool,
    hydrated: AtomicBool,
}

/// Reads Remote Config (feature flags + experiment assignments) from
/// `GET /v1/config`, caching the last-known payload both in memory and on disk
/// so flags resolve instantly and survive offline. Mirrors the offerings/
/// entitlements readers: a 60s scheduler tick refreshes in the background and
/// reads coalesce a single staleness-driven refresh.
pub struct RemoteConfigReader {
    inner: Arc<Inner>,
}

impl RemoteConfigReader {
    pub fn new(
        http: Arc<HttpClient>,
        store: Arc<CacheStore>,
        identity: Arc<IdentityManager>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                http,
                store,
                identity,
                clock: Arc::new(SystemClock),
                bus: None,
                state: RwLock::new(State::default()),
                last_refresh_ms: AtomicU64::new(0),
                refreshing: AtomicBool::new(false),
                hydrated: AtomicBool::new(false),
            }),
        }
    }

    pub fn with_clock(self, clock: Arc<dyn Clock>) -> Self {
        // Inner is freshly constructed and not yet shared, so the Arc is unique.
        let mut inner = Arc::try_unwrap(self.inner).unwrap_or_else(|arc| {
            // Should never happen during construction; fall back to a clone of fields.
            Inner {
                http: Arc::clone(&arc.http),
                store: Arc::clone(&arc.store),
                identity: Arc::clone(&arc.identity),
                clock: Arc::clone(&arc.clock),
                bus: arc.bus.clone(),
                state: RwLock::new(State::default()),
                last_refresh_ms: AtomicU64::new(0),
                refreshing: AtomicBool::new(false),
                hydrated: AtomicBool::new(false),
            }
        });
        inner.clock = clock;
        Self {
            inner: Arc::new(inner),
        }
    }

    pub fn with_observer_bus(self, bus: Arc<ObserverBus>) -> Self {
        let mut inner = Arc::try_unwrap(self.inner).unwrap_or_else(|arc| Inner {
            http: Arc::clone(&arc.http),
            store: Arc::clone(&arc.store),
            identity: Arc::clone(&arc.identity),
            clock: Arc::clone(&arc.clock),
            bus: arc.bus.clone(),
            state: RwLock::new(State::default()),
            last_refresh_ms: AtomicU64::new(0),
            refreshing: AtomicBool::new(false),
            hydrated: AtomicBool::new(false),
        });
        inner.bus = Some(bus);
        Self {
            inner: Arc::new(inner),
        }
    }

    /// Force a synchronous refresh from the server.
    pub fn refresh(&self) -> RovenueResult<()> {
        self.inner.refresh()
    }

    /// Trigger one coalesced background refresh if the cached payload is older
    /// than `staleness_ms`. Never blocks the caller; multiple concurrent reads
    /// collapse into a single in-flight GET.
    pub fn maybe_refresh_async(&self, staleness_ms: u64) {
        let now = self.inner.clock.now_unix_ms();
        let last = self.inner.last_refresh_ms.load(Ordering::SeqCst);
        if last != 0 && now.saturating_sub(last) < staleness_ms {
            return;
        }
        // Claim the in-flight slot; if another refresh holds it, bail.
        if self.inner.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            let _ = inner.refresh();
            inner.refreshing.store(false, Ordering::SeqCst);
        });
    }

    fn flag_value(&self, key: &str) -> Option<Value> {
        self.inner.ensure_hydrated();
        let guard = self.inner.state.read().ok()?;
        guard.flags.get(key).cloned()
    }

    pub fn bool(&self, key: &str, fallback: bool) -> bool {
        match self.flag_value(key) {
            Some(Value::Bool(b)) => b,
            _ => fallback,
        }
    }

    pub fn string(&self, key: &str, fallback: String) -> String {
        match self.flag_value(key) {
            Some(Value::String(s)) => s,
            _ => fallback,
        }
    }

    pub fn int(&self, key: &str, fallback: i64) -> i64 {
        match self.flag_value(key) {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback),
            _ => fallback,
        }
    }

    pub fn double(&self, key: &str, fallback: f64) -> f64 {
        match self.flag_value(key) {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(fallback),
            _ => fallback,
        }
    }

    /// Raw JSON string for any present flag (primitive, object, or array).
    /// `None` when the key is absent.
    pub fn json(&self, key: &str) -> Option<String> {
        self.flag_value(key).map(|v| v.to_string())
    }

    pub fn keys(&self) -> Vec<String> {
        self.inner.ensure_hydrated();
        let guard = match self.inner.state.read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        guard.flags.keys().cloned().collect()
    }

    pub fn experiment(&self, key: &str) -> Option<ExperimentAssignment> {
        self.inner.ensure_hydrated();
        let guard = self.inner.state.read().ok()?;
        guard.experiments.get(key).cloned()
    }

    pub fn experiments_all(&self) -> Vec<ExperimentAssignment> {
        self.inner.ensure_hydrated();
        let guard = match self.inner.state.read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        guard.experiments.values().cloned().collect()
    }

    /// The entire cached payload as a JSON string:
    /// `{ "flags": { key: value }, "experiments": { key: { experimentId, … } } }`.
    /// Façades parse this once to back a reactive, synchronous hook surface
    /// (e.g. RN `useRemoteConfig()`) without a bridge round-trip per read.
    pub fn all_json(&self) -> String {
        const EMPTY: &str = r#"{"flags":{},"experiments":{}}"#;
        self.inner.ensure_hydrated();
        let guard = match self.inner.state.read() {
            Ok(g) => g,
            Err(_) => return EMPTY.to_string(),
        };
        let experiments: serde_json::Map<String, Value> = guard
            .experiments
            .iter()
            .map(|(k, e)| {
                (
                    k.clone(),
                    serde_json::json!({
                        "experimentId": e.experiment_id,
                        "key": e.key,
                        "variantId": e.variant_id,
                        "variantName": e.variant_name,
                        "value": serde_json::from_str::<Value>(&e.value_json)
                            .unwrap_or(Value::Null),
                    }),
                )
            })
            .collect();
        serde_json::json!({
            "flags": Value::Object(guard.flags.clone()),
            "experiments": Value::Object(experiments),
        })
        .to_string()
    }
}

impl Inner {
    /// Lazily load the persisted payload into memory exactly once, so a
    /// just-launched (offline) app resolves flags from the last session.
    fn ensure_hydrated(&self) {
        if self.hydrated.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(Some(raw)) = RemoteConfigCacheRepo::new(&self.store).get(REMOTE_CONFIG_RESOURCE) {
            if let Ok(parsed) = serde_json::from_str::<ConfigResponse>(&raw) {
                if let Ok(mut guard) = self.state.write() {
                    *guard = build_state(parsed);
                }
            }
        }
    }

    fn refresh(&self) -> RovenueResult<()> {
        let scope = self.identity.current_user_scope();
        let req = HttpRequest::new("/v1/config").subscriber_id(&scope);
        match self.http.get_json::<ApiEnvelope<ConfigResponse>>(req) {
            Ok(resp) => {
                let body = resp.body.ok_or(RovenueError::Internal)?;
                // Persist the raw payload first (best-effort) so an offline
                // relaunch still has it even if the in-memory swap races.
                if let Ok(raw) = serde_json::to_string(&body.data) {
                    let _ = RemoteConfigCacheRepo::new(&self.store).put(
                        REMOTE_CONFIG_RESOURCE,
                        &raw,
                        self.clock.now_unix_ms(),
                    );
                }
                {
                    let mut guard = self.state.write().map_err(|_| RovenueError::Internal)?;
                    *guard = build_state(body.data);
                }
                self.hydrated.store(true, Ordering::SeqCst);
                self.last_refresh_ms
                    .store(self.clock.now_unix_ms(), Ordering::SeqCst);
                if let Some(bus) = &self.bus {
                    bus.emit(ChangeEvent::RemoteConfigChanged);
                }
                Ok(())
            }
            Err(e @ (RovenueError::NetworkUnavailable | RovenueError::Timeout)) => {
                // Connectivity failure: keep serving the last-known payload.
                // Hydrate from disk if memory is still cold, then surface the
                // original network error to the caller.
                self.ensure_hydrated();
                Err(e)
            }
            Err(e) => Err(e),
        }
    }
}

fn build_state(resp: ConfigResponse) -> State {
    let experiments = resp
        .experiments
        .into_iter()
        .map(|(k, w)| {
            (
                k,
                ExperimentAssignment {
                    experiment_id: w.experiment_id,
                    key: w.key,
                    variant_id: w.variant_id,
                    variant_name: w.variant_name,
                    value_json: w.value.to_string(),
                },
            )
        })
        .collect();
    State {
        flags: resp.flags,
        experiments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = r#"{"data":{
        "flags":{
            "new_paywall": true,
            "max_items": 5,
            "ratio": 1.5,
            "welcome_text": "hi",
            "theme": {"color":"blue"}
        },
        "experiments":{
            "checkout_test":{
                "experimentId":"exp_1",
                "key":"checkout_test",
                "type":"FEATURE",
                "variantId":"var_b",
                "variantName":"Treatment",
                "value":{"layout":"compact"}
            }
        }
    }}"#;

    fn make_reader(http: Arc<HttpClient>) -> (RemoteConfigReader, Arc<CacheStore>) {
        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let bus = Arc::new(ObserverBus::default());
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let identity = Arc::new(IdentityManager::new(
            Arc::clone(&store),
            Arc::clone(&bus),
            Arc::clone(&clock),
        ));
        let reader =
            RemoteConfigReader::new(http, Arc::clone(&store), identity).with_observer_bus(bus);
        (reader, store)
    }

    #[test]
    #[serial_test::serial]
    fn refresh_parses_flags_and_experiments_with_typed_getters() {
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/v1/config")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(BODY)
            .create();

        let http = Arc::new(HttpClient::new(server.url(), "pk_test".into()));
        let (reader, _store) = make_reader(http);

        reader.refresh().expect("refresh ok");

        assert!(reader.bool("new_paywall", false));
        assert_eq!(reader.int("max_items", 0), 5);
        assert_eq!(reader.double("ratio", 0.0), 1.5);
        assert_eq!(reader.string("welcome_text", "x".into()), "hi");
        assert_eq!(reader.json("theme").as_deref(), Some(r#"{"color":"blue"}"#));

        // Wrong-type / unknown keys fall back.
        assert!(reader.bool("missing", true));
        assert_eq!(reader.int("welcome_text", -1), -1);

        let exp = reader.experiment("checkout_test").expect("assignment");
        assert_eq!(exp.experiment_id, "exp_1");
        assert_eq!(exp.variant_name, "Treatment");
        assert_eq!(exp.value_json, r#"{"layout":"compact"}"#);
        assert_eq!(reader.experiments_all().len(), 1);
        assert!(reader.experiment("nope").is_none());

        // Bulk accessor round-trips to a single parseable object.
        let all: serde_json::Value = serde_json::from_str(&reader.all_json()).unwrap();
        assert_eq!(all["flags"]["new_paywall"], serde_json::json!(true));
        assert_eq!(all["flags"]["max_items"], serde_json::json!(5));
        assert_eq!(
            all["experiments"]["checkout_test"]["variantName"],
            serde_json::json!("Treatment")
        );
        assert_eq!(
            all["experiments"]["checkout_test"]["value"]["layout"],
            serde_json::json!("compact")
        );
    }

    #[test]
    #[serial_test::serial]
    fn sends_env_and_subscriber_headers() {
        let mut server = mockito::Server::new();
        let m = server
            .mock("GET", "/v1/config")
            .match_header("x-rovenue-env", "staging")
            .match_header("x-rovenue-user-id", mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"data":{"flags":{},"experiments":{}}}"#)
            .create();

        let http = Arc::new(
            HttpClient::new(server.url(), "pk_test".into())
                .with_environment(Some("staging".into())),
        );
        let (reader, _store) = make_reader(http);

        reader.refresh().expect("refresh ok");
        m.assert();
    }

    #[test]
    #[serial_test::serial]
    fn serves_cached_payload_offline() {
        // First reader refreshes successfully and persists to the shared store.
        let mut server = mockito::Server::new();
        let _m = server
            .mock("GET", "/v1/config")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(BODY)
            .create();

        let store = Arc::new(CacheStore::open_in_memory().unwrap());
        let bus = Arc::new(ObserverBus::default());
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let identity = Arc::new(IdentityManager::new(
            Arc::clone(&store),
            Arc::clone(&bus),
            Arc::clone(&clock),
        ));
        let http = Arc::new(HttpClient::new(server.url(), "pk_test".into()));
        let reader = RemoteConfigReader::new(http, Arc::clone(&store), Arc::clone(&identity));
        reader.refresh().expect("first refresh ok");

        // A brand-new reader over the SAME store, pointed at a dead endpoint,
        // still resolves flags from the persisted payload.
        let dead_http = Arc::new(HttpClient::new(
            "http://127.0.0.1:1".into(),
            "pk_test".into(),
        ));
        let cold = RemoteConfigReader::new(dead_http, Arc::clone(&store), identity);
        assert!(cold.bool("new_paywall", false));
        assert_eq!(cold.int("max_items", 0), 5);
    }
}
