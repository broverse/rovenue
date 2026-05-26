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
use super::types::{Entitlement, EntitlementsResponse};

const RESOURCE: &str = "entitlements";

pub struct EntitlementReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    http: Option<Arc<HttpClient>>,
    bus: Option<Arc<ObserverBus>>,
    clock: Option<Arc<dyn Clock>>,
}

impl EntitlementReader {
    pub fn new(store: Arc<CacheStore>, identity: Arc<IdentityManager>) -> Self {
        Self {
            store,
            identity,
            http: None,
            bus: None,
            clock: None,
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
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;

        let scope = self.identity.current_user_scope();
        let etag_repo = EtagRepo::new(&self.store);
        let prior_etag = etag_repo.get(RESOURCE)?;

        let mut req = HttpRequest::new("/v1/me/entitlements").user_scope(&scope);
        if let Some(ref e) = prior_etag {
            req = req.etag(e);
        }

        let resp = http.get_json::<ApiEnvelope<EntitlementsResponse>>(req)?;

        if resp.status == 304 {
            return Ok(());
        }

        let body = resp.body.ok_or(RovenueError::Internal)?;
        let now = clock.now_unix_ms();
        let rows = map_to_rows(body.data.entitlements, now);
        EntitlementsRepo::new(&self.store).upsert_many(&scope, &rows)?;
        if let Some(etag) = resp.etag {
            etag_repo.put(RESOURCE, &etag, now)?;
        }
        if let Some(bus) = &self.bus {
            bus.emit(ChangeEvent::EntitlementsChanged);
        }
        Ok(())
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
