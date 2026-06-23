use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::cache::ExposureRepo;
use crate::identity::IdentityManager;
use crate::remote_config::types::ExperimentAssignment;
use crate::time::Clock;
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpPostRequest;

#[derive(Serialize)]
struct ExposeBody<'a> {
    #[serde(rename = "variantId")]
    variant_id: &'a str,
    #[serde(rename = "subscriberId")]
    subscriber_id: &'a str,
}

/// Best-effort, deduped experiment-exposure reporter. Reads stay non-blocking:
/// the POST runs on a spawned thread and only marks the persistent dedup ledger
/// on success, so a failed report is retried on the next read.
///
/// `pending` is an in-memory set of `"scope\0experiment_id\0variant_id"` keys
/// that are currently in-flight or already persisted. It prevents spawning
/// duplicate threads for rapid back-to-back reads before the first thread's
/// HTTP round-trip has completed.
pub struct ExposureTracker {
    repo: ExposureRepo,
    http: Option<Arc<HttpClient>>,
    clock: Option<Arc<dyn Clock>>,
    identity: Arc<IdentityManager>,
    /// In-memory coalesce guard: tracks keys with an in-flight POST so rapid
    /// repeated reads don't fan-out N threads for the same (scope, exp, var).
    pending: Mutex<HashSet<String>>,
}

impl ExposureTracker {
    pub fn new(
        repo: ExposureRepo,
        http: Option<Arc<HttpClient>>,
        clock: Option<Arc<dyn Clock>>,
        identity: Arc<IdentityManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repo,
            http,
            clock,
            identity,
            pending: Mutex::new(HashSet::new()),
        })
    }

    /// Fire-and-forget exposure report for `assignment`. If http or clock are
    /// absent (unconfigured SDK), does nothing. Deduplicates via the persistent
    /// `ExposureRepo` ledger (checked synchronously before spawning) and via an
    /// in-memory `pending` set (blocks duplicate spawns for the same triple
    /// while the first thread's POST is in flight).
    pub fn maybe_track(self: &Arc<Self>, assignment: &ExperimentAssignment) {
        let (http, clock) = match (self.http.as_ref(), self.clock.as_ref()) {
            (Some(h), Some(c)) => (Arc::clone(h), Arc::clone(c)),
            _ => return,
        };

        let scope = self.identity.current_user_scope();
        let experiment_id = assignment.experiment_id.clone();
        let variant_id = assignment.variant_id.clone();

        // Build the coalesce key: NUL-separated to avoid collisions.
        let coalesce_key = format!("{scope}\0{experiment_id}\0{variant_id}");

        // Fast path: check in-memory pending set first (avoids SQLite read
        // for the common case of back-to-back reads after the first spawn).
        {
            let mut pending = match self.pending.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if pending.contains(&coalesce_key) {
                return;
            }
            // Also check the persistent ledger while we hold the lock so there
            // is no window between the check and the insert.
            if self
                .repo
                .is_exposed(&scope, &experiment_id, &variant_id)
                .unwrap_or(false)
            {
                // Already persisted — insert into pending so future reads skip
                // even the SQLite check.
                pending.insert(coalesce_key);
                return;
            }
            // Reserve the slot: mark in-flight before releasing the lock.
            pending.insert(coalesce_key.clone());
        }

        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let path = format!("/v1/experiments/{experiment_id}/expose");
            let body = ExposeBody {
                variant_id: &variant_id,
                subscriber_id: &scope,
            };
            // Use serde_json::Value as the response data type so that a 202 with
            // an empty or non-JSON body doesn't cause a deserialization failure.
            let res = http.post_json::<ExposeBody, ApiEnvelope<serde_json::Value>>(
                HttpPostRequest::new(&path).user_scope(&scope),
                &body,
            );
            if res.is_ok() {
                let _ = this
                    .repo
                    .mark(&scope, &experiment_id, &variant_id, clock.now_unix_ms());
                // Leave the key in `pending` — it acts as a permanent in-memory
                // sentinel so subsequent reads never even hit SQLite.
            } else {
                // On failure, remove the key from pending so the next read
                // retries the POST (dedup set only marks success).
                if let Ok(mut guard) = this.pending.lock() {
                    guard.remove(&coalesce_key);
                }
            }
        });
    }
}
