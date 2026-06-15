use std::sync::Arc;

use crate::error::{RovenueError, RovenueResult};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::types::{Offering, OfferingProduct, Offerings, OfferingsResponse};

pub struct OfferingsClient {
    http: Arc<HttpClient>,
}
impl OfferingsClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }
    pub fn get_offerings(&self) -> RovenueResult<Offerings> {
        let resp = self
            .http
            .get_json::<ApiEnvelope<OfferingsResponse>>(HttpRequest::new("/v1/offerings"))?;
        let body = resp.body.ok_or(RovenueError::Internal)?;
        let offerings: Vec<Offering> = body
            .data
            .offerings
            .into_iter()
            .map(|o| Offering {
                identifier: o.identifier,
                is_default: o.is_default,
                packages: o
                    .products
                    .into_iter()
                    .map(|p| OfferingProduct {
                        identifier: p.identifier,
                        product_type: p.product_type,
                        display_name: p.display_name,
                        apple_product_id: p.store_ids.apple,
                        google_product_id: p.store_ids.google,
                    })
                    .collect(),
            })
            .collect();
        let current = offerings
            .iter()
            .find(|o| o.is_default)
            .map(|o| o.identifier.clone());
        Ok(Offerings { current, offerings })
    }
}
