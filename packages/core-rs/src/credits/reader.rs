use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::cache::credits::{CreditBalanceRepo, CreditBalanceRow};
use crate::cache::CacheStore;
use crate::error::{RovenueError, RovenueResult};
use crate::identity::IdentityManager;
use crate::observer::{ChangeEvent, ObserverBus};
use crate::time::Clock;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::{HttpPostRequest, HttpRequest};

use super::types::{CreditBalanceWire, SpendBody, SpendResponse};

pub struct CreditReader {
    store: Arc<CacheStore>,
    identity: Arc<IdentityManager>,
    http: Option<Arc<HttpClient>>,
    bus: Option<Arc<ObserverBus>>,
    clock: Option<Arc<dyn Clock>>,
    last_refresh_ms: AtomicU64,
    #[allow(dead_code)]
    refreshing: AtomicBool,
}

impl CreditReader {
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

    pub fn balance(&self) -> RovenueResult<i64> {
        let scope = self.identity.current_user_scope();
        let repo = CreditBalanceRepo::new(&self.store);
        Ok(repo.get(&scope)?.map(|r| r.balance).unwrap_or(0))
    }

    pub fn refresh(&self) -> RovenueResult<()> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;
        let scope = self.identity.current_user_scope();

        let resp = http.get_json::<ApiEnvelope<CreditBalanceWire>>(
            HttpRequest::new("/v1/me/credits").user_scope(&scope),
        )?;
        let body = resp.body.ok_or(RovenueError::Internal)?;
        self.store_and_emit(&scope, body.data.balance, clock.now_unix_ms())
    }

    pub fn consume(
        &self,
        amount: i64,
        description: Option<&str>,
        idempotency_key: &str,
    ) -> RovenueResult<i64> {
        let http = self.http.as_ref().ok_or(RovenueError::Internal)?;
        let clock = self.clock.as_ref().ok_or(RovenueError::Internal)?;
        let scope = self.identity.current_user_scope();

        let resp = http.post_json::<SpendBody, ApiEnvelope<SpendResponse>>(
            HttpPostRequest::new("/v1/me/credits/spend")
                .user_scope(&scope)
                .idempotency_key(idempotency_key),
            &SpendBody {
                amount,
                description,
            },
        )?;
        let body = resp.body.ok_or(RovenueError::Internal)?;
        let new_balance = body.data.balance;
        self.store_and_emit(&scope, new_balance, clock.now_unix_ms())?;
        Ok(new_balance)
    }

    /// Set the balance straight from a known value (e.g. a receipt POST
    /// response) — no network. Stamps freshness and emits on change.
    pub fn set_balance(&self, scope: &str, balance: i64, now: u64) -> RovenueResult<()> {
        self.store_and_emit(scope, balance, now)?;
        self.last_refresh_ms.store(now, Ordering::Relaxed);
        Ok(())
    }

    fn store_and_emit(&self, scope: &str, balance: i64, now: u64) -> RovenueResult<()> {
        let repo = CreditBalanceRepo::new(&self.store);
        let prior = repo.get(scope)?.map(|r| r.balance);
        repo.upsert(&CreditBalanceRow {
            user_scope: scope.to_string(),
            balance,
            updated_at_ms: now,
        })?;
        if prior != Some(balance) {
            if let Some(bus) = &self.bus {
                bus.emit(ChangeEvent::CreditBalanceChanged);
            }
        }
        Ok(())
    }
}
