use crate::cache::entitlements::EntitlementRow;

use super::types::EntitlementWire;

pub fn wire_to_row(w: EntitlementWire, updated_at_ms: u64) -> EntitlementRow {
    EntitlementRow {
        entitlement_id: w.id,
        is_active: w.is_active,
        product_id: w.product_id,
        expires_at_ms: w.expires_at_ms,
        updated_at_ms,
        // v2 fields — will be populated by T5 wire model rewrite
        store: String::new(),
        product_identifier: String::new(),
        expires_iso: None,
    }
}
