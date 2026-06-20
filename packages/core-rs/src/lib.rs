// UniFFI-generated scaffolding triggers this lint; suppress it crate-wide.
#![allow(clippy::empty_line_after_doc_comments)]

pub mod api;
pub mod attributes;
pub mod cache;
pub mod config;
pub mod entitlements;
pub mod error;
pub mod events;
pub mod exposure;
pub mod funnel;
pub mod identify;
pub mod identity;
pub mod observer;
pub mod offerings;
pub mod polling;
pub mod receipts;
pub mod remote_config;
pub mod sessions;
pub mod time;
pub mod transport;
pub mod version;
pub mod virtual_currencies;

pub use api::RovenueCore;
pub use config::Config;
pub use entitlements::Entitlement;
pub use error::{RovenueError, RovenueResult};
pub use events::{EventEnvelope, IdentityContext, EVENT_WIRE_VERSION};
pub use funnel::{ClaimInstallParams, FunnelClaimBus, FunnelClaimListener, FunnelClaimResult, FunnelClient};
pub use identify::{IdentifyClient, IdentifyResult};
pub use identity::User;
pub use observer::{ChangeEvent, Observer};
pub use offerings::{CoreOffering, CoreOfferingProduct, CoreOfferings};
pub use receipts::ReceiptResult;
pub use remote_config::{ExperimentAssignment, RemoteConfigReader};
pub use sessions::SessionEventKind;
pub use version::SDK_VERSION;

pub fn sdk_version() -> String {
    SDK_VERSION.to_string()
}

uniffi::include_scaffolding!("librovenue");
