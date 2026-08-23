import { logger } from "../../lib/logger";
import { GOOGLE_REFERENCE_REGION } from "./google-play-prices";
import {
  getOneTimeProductPricing,
  getSubscriptionBasePlanPricing,
  type BasePlanPricing,
  type GoogleVerifyConfig,
} from "./google-verify";

const log = logger.child("google-pricing");

// Safe pricing resolution shared by the RTDN webhook and the receipt-verify
// path, so both derive revenue amounts through the SAME machinery. Every
// resolver returns `null` instead of throwing — and callers must treat null
// as "skip the revenue event", NEVER as 0/USD (a 0-USD row silently corrupts
// MRR/LTV rollups downstream).

export interface ResolveSubscriptionPricingArgs {
  /** Google store product id (subscriptionsv2 `lineItems[].productId`). */
  productId: string;
  basePlanId: string | undefined;
  regionCode: string | undefined;
}

/**
 * Resolve a subscription base plan's list price for the purchase's region
 * (falling back to {@link GOOGLE_REFERENCE_REGION} when Google omitted the
 * region). Returns `null` when the base plan is unknown or the lookup fails.
 */
export async function resolveSubscriptionPricing(
  config: GoogleVerifyConfig,
  args: ResolveSubscriptionPricingArgs,
): Promise<BasePlanPricing | null> {
  if (!args.basePlanId) return null;

  try {
    return await getSubscriptionBasePlanPricing(
      config,
      args.productId,
      args.basePlanId,
      args.regionCode ?? GOOGLE_REFERENCE_REGION,
    );
  } catch (err) {
    log.warn("basePlan pricing lookup failed", {
      productId: args.productId,
      basePlanId: args.basePlanId,
      regionCode: args.regionCode,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ResolveOneTimePricingArgs {
  /** Google store product id (the in-app product SKU). */
  productId: string;
  regionCode: string | undefined;
}

/**
 * Resolve a one-time (managed) product's list price. Same contract as
 * {@link resolveSubscriptionPricing}: `null` on any miss, never 0/USD.
 */
export async function resolveOneTimeProductPricing(
  config: GoogleVerifyConfig,
  args: ResolveOneTimePricingArgs,
): Promise<BasePlanPricing | null> {
  try {
    return await getOneTimeProductPricing(
      config,
      args.productId,
      args.regionCode ?? GOOGLE_REFERENCE_REGION,
    );
  } catch (err) {
    log.warn("one-time product pricing lookup failed", {
      productId: args.productId,
      regionCode: args.regionCode,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
