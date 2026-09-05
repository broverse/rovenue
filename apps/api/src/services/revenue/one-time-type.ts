import type { ProductType, RevenueEventType } from "@rovenue/db";

// =============================================================
// One-time purchase revenue typing
// =============================================================
//
// A purchase that does not renew must not be recorded as INITIAL. Three
// things go wrong when it is: the recurring MRR decomposition counts it
// as new recurring revenue, the ad platforms receive "Subscribe" for a
// coin pack, and credit-pack revenue reporting has no way to find it.
//
// A TOTAL Record, so a fourth ProductType is a compile error rather than
// a value that quietly falls through to the subscription branch.
//
// CREDIT_PURCHASE means "a consumable IAP was bought". A CONSUMABLE with
// no product_currency_grants rows grants nothing at all — a
// misconfiguration — and will still be filed here. Keying on the grants
// table instead was considered and rejected in the spec: it adds a read
// to every revenue write and makes the type a function of mutable
// configuration, so two purchases of the same product could carry
// different types over time.
const ONE_TIME_REVENUE_TYPE: Record<ProductType, RevenueEventType | null> = {
  SUBSCRIPTION: null,
  CONSUMABLE: "CREDIT_PURCHASE",
  NON_CONSUMABLE: "NON_RENEWING_PURCHASE",
};

/**
 * The revenue type for a purchase of this product, or `null` when the
 * product is a subscription and the caller's own INITIAL / RENEWAL /
 * TRIAL_CONVERSION classification stands.
 */
export function oneTimeRevenueTypeFor(
  productType: ProductType,
): RevenueEventType | null {
  return ONE_TIME_REVENUE_TYPE[productType];
}
