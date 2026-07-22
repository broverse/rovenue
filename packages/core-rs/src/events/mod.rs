// =============================================================
// events — SDK event wire types (M7)
// =============================================================

pub mod client;
pub mod envelope;
pub mod identity_context;

pub use client::EventsClient;
pub use envelope::{EventEnvelope, PaywallContext};
pub use identity_context::IdentityContext;

/// Wire version embedded in outbox_events rows so consumers can
/// detect schema drift without inspecting the payload shape.
pub const EVENT_WIRE_VERSION: u8 = 1;
