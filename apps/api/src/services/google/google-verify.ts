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
