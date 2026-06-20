pub mod client;

pub use client::FunnelClient;

use std::sync::{Arc, Mutex};

/// FFI-facing result of a resolved funnel claim. `funnel_answers_json` is the
/// raw `funnel_answers` object serialized to a JSON string (uniffi can't carry
/// arbitrary JSON — façades parse it).
#[derive(Debug, Clone)]
pub struct FunnelClaimResult {
    pub subscriber_id: String,
    pub funnel_answers_json: String,
}

/// Inputs for `claim_install`. Device fields are caller-supplied; the core
/// fills `install_id` itself.
#[derive(Debug, Clone)]
pub struct ClaimInstallParams {
    pub platform: String,
    pub locale: String,
    pub timezone: String,
    pub screen_dims: String,
    pub device_model: Option<String>,
    pub install_referrer: Option<String>,
}

/// Implemented by façades to receive the resolved claim. Mirrors `Observer`.
pub trait FunnelClaimListener: Send + Sync {
    fn on_funnel_claim_resolved(&self, result: FunnelClaimResult);
}

/// Holds the registered listener(s) and fans out claim resolutions. Mirrors
/// `ObserverBus` (the FFI passes a `Box<dyn FunnelClaimListener>` once).
#[derive(Default)]
pub struct FunnelClaimBus {
    subs: Mutex<Vec<Arc<dyn FunnelClaimListener>>>,
}

impl FunnelClaimBus {
    pub fn register(&self, l: Arc<dyn FunnelClaimListener>) {
        self.subs.lock().unwrap_or_else(|e| e.into_inner()).push(l);
    }

    pub fn emit(&self, result: FunnelClaimResult) {
        let guard = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        for s in guard.iter() {
            s.on_funnel_claim_resolved(result.clone());
        }
    }
}
