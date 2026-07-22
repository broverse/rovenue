use std::sync::Arc;

use crate::cache::offerings::OfferingsCacheRepo;
use crate::cache::CacheStore;
use crate::error::{ErrorKind, RovenueError, RovenueResult};
use crate::time::{Clock, SystemClock};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::types::{
    CoreOffering, CoreOfferingProduct, CoreOfferings, OfferingWire, OfferingsResponse,
};

/// Cache key for the (single, project-scoped) offerings payload.
const OFFERINGS_RESOURCE: &str = "offerings";

pub struct OfferingsClient {
    http: Arc<HttpClient>,
    store: Arc<CacheStore>,
    clock: Arc<dyn Clock>,
}

impl OfferingsClient {
    pub fn new(http: Arc<HttpClient>, store: Arc<CacheStore>) -> Self {
        Self {
            http,
            store,
            clock: Arc::new(SystemClock),
        }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Fetch offerings.
    ///
    /// On a successful live fetch the raw `OfferingsResponse` JSON is persisted
    /// and the mapped result returned. If the fetch fails with a
    /// *connectivity*-class error (`NetworkUnavailable` / `Timeout`), the last
    /// cached offerings are served so paywalls keep rendering offline.
    ///
    /// Auth (`InvalidApiKey`) and server (`ServerError`, `RateLimited`,
    /// `Internal`) failures are propagated as before — stale offerings are NOT
    /// served on these because they indicate a reachable-but-rejecting backend,
    /// not loss of connectivity.
    pub fn get_offerings(&self) -> RovenueResult<CoreOfferings> {
        match self
            .http
            .get_json::<ApiEnvelope<OfferingsResponse>>(HttpRequest::new("/v1/offerings"))
        {
            Ok(resp) => {
                let body = resp.body.ok_or(RovenueError::Internal())?;
                // Persist the raw response (best-effort: a cache write failure
                // must not fail an otherwise-successful fetch).
                if let Ok(raw) = serde_json::to_string(&body.data) {
                    let _ = OfferingsCacheRepo::new(&self.store).put(
                        OFFERINGS_RESOURCE,
                        &raw,
                        self.clock.now_unix_ms(),
                    );
                }
                Ok(map_response(body.data))
            }
            Err(e) if matches!(e.kind, ErrorKind::NetworkUnavailable | ErrorKind::Timeout) => {
                // Connectivity failure: serve last-known offerings if present,
                // otherwise propagate the original network error.
                match OfferingsCacheRepo::new(&self.store).get(OFFERINGS_RESOURCE)? {
                    Some(raw) => {
                        let parsed: OfferingsResponse =
                            serde_json::from_str(&raw).map_err(|_| RovenueError::Internal())?;
                        Ok(map_response(parsed))
                    }
                    None => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    }
}

fn map_response(resp: OfferingsResponse) -> CoreOfferings {
    let offerings: Vec<CoreOffering> = resp.offerings.into_iter().map(map_offering).collect();
    let current = offerings
        .iter()
        .find(|o| o.is_default)
        .map(|o| o.identifier.clone());
    CoreOfferings { current, offerings }
}

/// Shared wire→FFI mapping for a single offering, reused by the placements
/// client (a placement's `paywall.offering` is the exact same
/// `OfferingWire` shape `GET /v1/offerings` returns per-item).
pub(crate) fn map_offering(o: OfferingWire) -> CoreOffering {
    CoreOffering {
        identifier: o.identifier,
        is_default: o.is_default,
        packages: o
            .packages
            .into_iter()
            .map(|p| CoreOfferingProduct {
                package_identifier: p.package_identifier,
                identifier: p.identifier,
                product_type: p.product_type,
                display_name: p.display_name,
                apple_product_id: p.store_ids.apple,
                google_product_id: p.store_ids.google,
                android_base_plan_id: p.android_base_plan_id,
                android_offer_id: p.android_offer_id,
            })
            .collect(),
    }
}
