use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct CreditBalance {
    pub balance: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreditBalanceWire {
    pub balance: i64,
}

#[derive(Debug, Serialize)]
pub struct SpendBody<'a> {
    pub amount: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct SpendResponse {
    pub balance: i64,
}
