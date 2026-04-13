import { google, type androidpublisher_v3 } from "googleapis";
import { logger } from "../../lib/logger";
import { getGoogleAuthClient } from "./google-auth";
import type {
  GoogleServiceAccountCredentials,
  GoogleSubscriptionPurchaseV2,
} from "./google-types";

const log = logger.child("google-verify");

export interface GoogleVerifyConfig {
  credentials: GoogleServiceAccountCredentials;
  packageName: string;
}

function androidPublisher(
  credentials: GoogleServiceAccountCredentials,
): androidpublisher_v3.Androidpublisher {
  const auth = getGoogleAuthClient(credentials);
  return google.androidpublisher({ version: "v3", auth });
}

/**
 * Fetch the canonical current state of a subscription purchase via
 * {@link https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get
 * purchases.subscriptionsv2.get}. Returns the full
 * SubscriptionPurchaseV2 so callers can inspect line items, cancellation
 * context, and external account identifiers.
 */
export async function verifyGoogleSubscription(
  config: GoogleVerifyConfig,
  purchaseToken: string,
): Promise<GoogleSubscriptionPurchaseV2> {
  const client = androidPublisher(config.credentials);
  const response = await client.purchases.subscriptionsv2.get({
    packageName: config.packageName,
    token: purchaseToken,
  });

  log.debug("verified subscription purchase", {
    packageName: config.packageName,
    tokenPrefix: purchaseToken.slice(0, 12),
    state: response.data.subscriptionState,
  });

  return response.data as unknown as GoogleSubscriptionPurchaseV2;
}

/**
 * Fetch a one-time product purchase via
 * {@link https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/get
 * purchases.products.get}.
 */
export async function verifyGoogleProductPurchase(
  config: GoogleVerifyConfig,
  productId: string,
  purchaseToken: string,
): Promise<androidpublisher_v3.Schema$ProductPurchase> {
  const client = androidPublisher(config.credentials);
  const response = await client.purchases.products.get({
    packageName: config.packageName,
    productId,
    token: purchaseToken,
  });
  return response.data;
}

/**
 * Acknowledge a subscription purchase. Google revokes unacknowledged
 * purchases after ~3 days, so webhook handlers should call this after
 * granting entitlement.
 */
export async function acknowledgeGoogleSubscription(
  config: GoogleVerifyConfig,
  subscriptionId: string,
  purchaseToken: string,
): Promise<void> {
  const client = androidPublisher(config.credentials);
  await client.purchases.subscriptions.acknowledge({
    packageName: config.packageName,
    subscriptionId,
    token: purchaseToken,
  });
  log.debug("acknowledged subscription", {
    packageName: config.packageName,
    subscriptionId,
  });
}

// =============================================================
// Base plan pricing (monetization.subscriptions.get)
// =============================================================

export interface BasePlanPricing {
  amount: number;
  currency: string;
}

interface CachedPricing extends BasePlanPricing {
  expiresAt: number;
}

const PRICING_CACHE_TTL_MS = 60 * 60 * 1000;
const pricingCache = new Map<string, CachedPricing>();

/**
 * Look up the list price for a subscription's base plan in a given region.
 * Calls monetization.subscriptions.get and walks basePlans → regionalConfigs
 * for the matching regionCode. Result is cached in-process for 1 hour to
 * keep webhook processing cheap on repeat renewals.
 *
 * Returns `null` when the base plan, region, or price field cannot be
 * resolved — callers should fall back to 0/USD and log the miss.
 */
export async function getSubscriptionBasePlanPricing(
  config: GoogleVerifyConfig,
  productId: string,
  basePlanId: string,
  regionCode: string,
): Promise<BasePlanPricing | null> {
  const cacheKey = `${config.packageName}:${productId}:${basePlanId}:${regionCode}`;
  const now = Date.now();
  const cached = pricingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { amount: cached.amount, currency: cached.currency };
  }

  const client = androidPublisher(config.credentials);
  const response = await client.monetization.subscriptions.get({
    packageName: config.packageName,
    productId,
  });

  const basePlan = response.data.basePlans?.find(
    (bp) => bp.basePlanId === basePlanId,
  );
  const regional = basePlan?.regionalConfigs?.find(
    (rc) => rc.regionCode === regionCode,
  );
  const money = regional?.price;

  if (!money || !money.currencyCode) {
    log.warn("basePlan pricing lookup returned no price", {
      packageName: config.packageName,
      productId,
      basePlanId,
      regionCode,
    });
    return null;
  }

  const units = Number(money.units ?? 0);
  const nanos = money.nanos ?? 0;
  const pricing: BasePlanPricing = {
    amount: units + nanos / 1_000_000_000,
    currency: money.currencyCode,
  };

  pricingCache.set(cacheKey, {
    ...pricing,
    expiresAt: now + PRICING_CACHE_TTL_MS,
  });

  log.debug("fetched basePlan pricing", {
    productId,
    basePlanId,
    regionCode,
    amount: pricing.amount,
    currency: pricing.currency,
  });

  return pricing;
}
