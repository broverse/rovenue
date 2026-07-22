use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::cache::placements::PlacementsCacheRepo;
use crate::cache::CacheStore;
use crate::error::{ErrorKind, RovenueError, RovenueResult};
use crate::logging::{LogLevel, Logger};
use crate::offerings::client::map_offering;
use crate::time::{Clock, SystemClock};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::{HttpPostRequest, HttpRequest};

use super::bucketing::{assign_bucket, select_variant_index};
use super::types::{
    CorePaywall, CorePresentedContext, ExperimentWire, PaywallWire, PlacementInfoWire,
    PlacementsResponse,
};

#[derive(Serialize)]
struct ExposeBody<'a> {
    #[serde(rename = "variantId")]
    variant_id: &'a str,
    #[serde(rename = "subscriberId")]
    subscriber_id: &'a str,
    #[serde(rename = "placementId")]
    placement_id: &'a str,
}

pub struct PlacementsClient {
    http: Arc<HttpClient>,
    store: Arc<CacheStore>,
    clock: Arc<dyn Clock>,
    logger: Option<Arc<Logger>>,
    /// In-memory bundled-fallback-file map: `identifier -> raw
    /// PlacementsResponse JSON string`, loaded (once, wholesale-replaced)
    /// by `set_fallback` (see `RovenueCore::set_fallback_placements` /
    /// `placements::fallback::parse_fallback_file`). Decoded lazily per
    /// `get_paywall` call — same raw-string-storage rationale as the disk
    /// cache (see `fallback.rs` doc comment): `PlacementsResponse` isn't
    /// `Clone`.
    fallback: Mutex<HashMap<String, String>>,
}

impl PlacementsClient {
    pub fn new(http: Arc<HttpClient>, store: Arc<CacheStore>) -> Self {
        Self {
            http,
            store,
            clock: Arc::new(SystemClock),
            logger: None,
            fallback: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Attach a logger so the fire-and-forget exposure POST can log (never
    /// propagate) a failure. Optional: with no logger, expose failures are
    /// silently swallowed.
    pub fn with_logger(mut self, logger: Arc<Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Replace the in-memory bundled-fallback-file map wholesale (called
    /// once by `RovenueCore::set_fallback_placements`, after
    /// `fallback::parse_fallback_file` has already validated the file and
    /// decoded each entry once to confirm it parses as `PlacementsResponse`
    /// — the raw strings stored here are re-decoded lazily per
    /// `get_paywall` call, same as the disk cache).
    pub fn set_fallback(&self, entries: HashMap<String, String>) {
        if let Ok(mut guard) = self.fallback.lock() {
            *guard = entries;
        }
    }

    /// Fetch + resolve `GET /v1/placements/{identifier}?locale=`.
    ///
    /// `Ok(None)` means the placement resolved to nothing — unknown/inactive
    /// placement, a `target: none` row, a retired paywall/experiment
    /// reference, or no row matched. This is NOT an error: a shipped app
    /// must never crash because a placement was retired server-side.
    ///
    /// On a successful live fetch the raw response JSON is cached under
    /// `placement:{identifier}`. On `NetworkUnavailable`/`Timeout` the last
    /// cached response (if any) is re-resolved instead (a fresh bucket draw
    /// runs against the cached experiment payload). If there's no cached
    /// response either, the bundled fallback map (see `set_fallback`) is
    /// consulted as a last resort — cache always beats fallback, and the
    /// fallback is only ever consulted on this same connectivity-class
    /// branch (never for auth/server errors, which propagate exactly as
    /// before). Any other error propagates unchanged.
    pub fn get_paywall(
        &self,
        identifier: &str,
        locale: Option<&str>,
        subscriber_id: &str,
    ) -> RovenueResult<Option<CorePaywall>> {
        let cache_key = format!("placement:{identifier}");
        let path = match locale {
            Some(l) if !l.is_empty() => format!("/v1/placements/{identifier}?locale={l}"),
            _ => format!("/v1/placements/{identifier}"),
        };
        let req = HttpRequest::new(&path).subscriber_id(subscriber_id);

        match self.http.get_json::<ApiEnvelope<PlacementsResponse>>(req) {
            Ok(resp) => {
                let body = resp.body.ok_or(RovenueError::Internal())?;
                // Persist the raw response (best-effort: a cache write
                // failure must not fail an otherwise-successful fetch).
                if let Ok(raw) = serde_json::to_string(&body.data) {
                    let _ = PlacementsCacheRepo::new(&self.store).put(
                        &cache_key,
                        &raw,
                        self.clock.now_unix_ms(),
                    );
                }
                Ok(self.resolve(body.data, subscriber_id, false))
            }
            Err(e) if matches!(e.kind, ErrorKind::NetworkUnavailable | ErrorKind::Timeout) => {
                match PlacementsCacheRepo::new(&self.store).get(&cache_key)? {
                    Some(raw) => {
                        let parsed: PlacementsResponse =
                            serde_json::from_str(&raw).map_err(|_| RovenueError::Internal())?;
                        Ok(self.resolve(parsed, subscriber_id, false))
                    }
                    None => match self.fallback_raw(identifier) {
                        Some(raw) => match serde_json::from_str::<PlacementsResponse>(&raw) {
                            Ok(parsed) => Ok(self.resolve(parsed, subscriber_id, true)),
                            // A stored fallback entry that fails to
                            // re-decode is unreachable in practice (it was
                            // already validated by parse_fallback_file
                            // before being stored), but must not panic —
                            // fall through to the original network error.
                            Err(_) => Err(e),
                        },
                        None => Err(e),
                    },
                }
            }
            Err(e) => Err(e),
        }
    }

    fn fallback_raw(&self, identifier: &str) -> Option<String> {
        self.fallback
            .lock()
            .ok()
            .and_then(|guard| guard.get(identifier).cloned())
    }

    /// Resolve the decoded wire response into a `CorePaywall`, drawing a
    /// variant (and firing the best-effort expose beacon) when the response
    /// carries an `experiment` branch instead of a direct `paywall`.
    /// `served_from_fallback` is stamped verbatim onto the result — `true`
    /// only for the bundled-fallback-file branch of `get_paywall`.
    fn resolve(
        &self,
        resp: PlacementsResponse,
        subscriber_id: &str,
        served_from_fallback: bool,
    ) -> Option<CorePaywall> {
        let placement = resp.placement?;

        if let Some(paywall) = resp.paywall {
            return Some(build_paywall(
                placement,
                paywall,
                None,
                None,
                served_from_fallback,
            ));
        }

        let experiment = resp.experiment?;
        if experiment.variants.is_empty() {
            return None;
        }

        let ExperimentWire { id, key, variants } = experiment;
        let weights: Vec<f64> = variants.iter().map(|v| v.weight).collect();
        let bucket = assign_bucket(subscriber_id, &key);
        let idx = select_variant_index(bucket, &weights);
        let variant = variants.into_iter().nth(idx)?;

        self.fire_expose(
            &id,
            &variant.variant_id,
            subscriber_id,
            &placement.identifier,
        );

        Some(build_paywall(
            placement,
            variant.paywall,
            Some(variant.variant_id),
            Some(key),
            served_from_fallback,
        ))
    }

    /// Best-effort `POST /v1/experiments/{id}/expose`, mirroring
    /// `ExposureTracker::maybe_track`'s fire-and-forget-on-a-thread pattern
    /// (the established async facility in this crate — there is no
    /// crate-wide async runtime). Errors are logged (when a logger is
    /// attached) and otherwise swallowed; they never affect the paywall
    /// already resolved and returned to the caller.
    fn fire_expose(
        &self,
        experiment_id: &str,
        variant_id: &str,
        subscriber_id: &str,
        placement_id: &str,
    ) {
        let http = Arc::clone(&self.http);
        let logger = self.logger.clone();
        let experiment_id = experiment_id.to_string();
        let variant_id = variant_id.to_string();
        let subscriber_id = subscriber_id.to_string();
        let placement_id = placement_id.to_string();

        std::thread::spawn(move || {
            let path = format!("/v1/experiments/{experiment_id}/expose");
            let body = ExposeBody {
                variant_id: &variant_id,
                subscriber_id: &subscriber_id,
                placement_id: &placement_id,
            };
            // Use serde_json::Value as the response data type so a 202 with
            // an empty or non-JSON body doesn't cause a deserialization
            // failure.
            let res = http.post_json::<ExposeBody<'_>, ApiEnvelope<serde_json::Value>>(
                HttpPostRequest::new(&path).user_scope(&subscriber_id),
                &body,
            );
            if let Err(e) = res {
                if let Some(logger) = &logger {
                    let kind = format!("{:?}", e.kind);
                    logger.log(
                        LogLevel::Warn,
                        || "placement expose failed".to_string(),
                        move || {
                            let mut f = std::collections::HashMap::new();
                            f.insert("op".to_string(), "placement_expose".to_string());
                            f.insert("kind".to_string(), kind);
                            f
                        },
                    );
                }
            }
        });
    }
}

fn build_paywall(
    placement: PlacementInfoWire,
    paywall: PaywallWire,
    variant_id: Option<String>,
    experiment_key: Option<String>,
    served_from_fallback: bool,
) -> CorePaywall {
    let (remote_config_json, remote_config_locale) = match paywall.remote_config {
        Some(rc) => (Some(rc.data.to_string()), Some(rc.locale)),
        None => (None, None),
    };

    let presented_context = Some(CorePresentedContext {
        placement_id: placement.identifier.clone(),
        paywall_id: paywall.id.clone(),
        variant_id,
        experiment_key,
        revision: placement.revision,
    });

    CorePaywall {
        placement_identifier: placement.identifier,
        placement_revision: placement.revision,
        paywall_identifier: Some(paywall.identifier),
        paywall_name: Some(paywall.name),
        config_format_version: paywall.config_format_version,
        remote_config_json,
        remote_config_locale,
        builder_config_json: paywall.builder_config.map(|v| v.to_string()),
        offering: paywall.offering.map(map_offering),
        presented_context,
        served_from_fallback,
    }
}
