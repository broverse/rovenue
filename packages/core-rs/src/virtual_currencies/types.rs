use serde::Deserialize;
use std::collections::HashMap;

/// Wire shape of GET /v1/virtual-currencies/me's `data` field.
#[derive(Debug, Deserialize)]
pub struct VcBalancesWire {
    pub balances: HashMap<String, i64>,
}
