// =============================================================
// App Store Server Notifications V2 — enums
// https://developer.apple.com/documentation/appstoreservernotifications
// =============================================================

import { APPLE_FAMILY_SHARED_OWNERSHIP_TYPE } from "@rovenue/shared/subscription-status";

export const APPLE_NOTIFICATION_TYPE = {
  SUBSCRIBED: "SUBSCRIBED",
  DID_CHANGE_RENEWAL_PREF: "DID_CHANGE_RENEWAL_PREF",
  DID_CHANGE_RENEWAL_STATUS: "DID_CHANGE_RENEWAL_STATUS",
  OFFER_REDEEMED: "OFFER_REDEEMED",
  DID_RENEW: "DID_RENEW",
  EXPIRED: "EXPIRED",
  DID_FAIL_TO_RENEW: "DID_FAIL_TO_RENEW",
  GRACE_PERIOD_EXPIRED: "GRACE_PERIOD_EXPIRED",
  PRICE_INCREASE: "PRICE_INCREASE",
  REFUND: "REFUND",
  REFUND_DECLINED: "REFUND_DECLINED",
  REFUND_REVERSED: "REFUND_REVERSED",
  CONSUMPTION_REQUEST: "CONSUMPTION_REQUEST",
  RENEWAL_EXTENDED: "RENEWAL_EXTENDED",
  RENEWAL_EXTENSION: "RENEWAL_EXTENSION",
  REVOKE: "REVOKE",
  // EU DMA / US link entitlement. Carries NO `data` — see
  // AppleExternalPurchaseToken below.
  EXTERNAL_PURCHASE_TOKEN: "EXTERNAL_PURCHASE_TOKEN",
  TEST: "TEST",
} as const;
export type AppleNotificationType =
  (typeof APPLE_NOTIFICATION_TYPE)[keyof typeof APPLE_NOTIFICATION_TYPE];

export const APPLE_NOTIFICATION_SUBTYPE = {
  INITIAL_BUY: "INITIAL_BUY",
  RESUBSCRIBE: "RESUBSCRIBE",
  DOWNGRADE: "DOWNGRADE",
  UPGRADE: "UPGRADE",
  AUTO_RENEW_ENABLED: "AUTO_RENEW_ENABLED",
  AUTO_RENEW_DISABLED: "AUTO_RENEW_DISABLED",
  VOLUNTARY: "VOLUNTARY",
  BILLING_RETRY: "BILLING_RETRY",
  PRICE_INCREASE: "PRICE_INCREASE",
  GRACE_PERIOD: "GRACE_PERIOD",
  BILLING_RECOVERY: "BILLING_RECOVERY",
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  PRODUCT_NOT_FOR_SALE: "PRODUCT_NOT_FOR_SALE",
  SUMMARY: "SUMMARY",
  FAILURE: "FAILURE",
} as const;
export type AppleNotificationSubtype =
  (typeof APPLE_NOTIFICATION_SUBTYPE)[keyof typeof APPLE_NOTIFICATION_SUBTYPE];

export const APPLE_ENVIRONMENT = {
  PRODUCTION: "Production",
  SANDBOX: "Sandbox",
} as const;
export type AppleEnvironment =
  (typeof APPLE_ENVIRONMENT)[keyof typeof APPLE_ENVIRONMENT];

export const APPLE_TRANSACTION_TYPE = {
  AUTO_RENEWABLE_SUBSCRIPTION: "Auto-Renewable Subscription",
  NON_CONSUMABLE: "Non-Consumable",
  CONSUMABLE: "Consumable",
  NON_RENEWING_SUBSCRIPTION: "Non-Renewing Subscription",
} as const;
export type AppleTransactionType =
  (typeof APPLE_TRANSACTION_TYPE)[keyof typeof APPLE_TRANSACTION_TYPE];

export const APPLE_OWNERSHIP_TYPE = {
  PURCHASED: "PURCHASED",
  // Sourced from @rovenue/shared so this and the db repository's revenue
  // suppression (packages/db/src/drizzle/repositories/revenue-events.ts)
  // can never drift onto different literals.
  FAMILY_SHARED: APPLE_FAMILY_SHARED_OWNERSHIP_TYPE,
} as const;
export type AppleOwnershipType =
  (typeof APPLE_OWNERSHIP_TYPE)[keyof typeof APPLE_OWNERSHIP_TYPE];

// Offer types per Apple's docs:
// 1 = introductory, 2 = promotional, 3 = subscription offer code, 4 = win-back
export const APPLE_OFFER_TYPE = {
  INTRODUCTORY: 1,
  PROMOTIONAL: 2,
  SUBSCRIPTION_OFFER_CODE: 3,
  WIN_BACK: 4,
} as const;
export type AppleOfferType =
  (typeof APPLE_OFFER_TYPE)[keyof typeof APPLE_OFFER_TYPE];

// =============================================================
// JWS decoded payloads
// =============================================================

export interface AppleJwsTransactionPayload {
  transactionId: string;
  originalTransactionId: string;
  webOrderLineItemId?: string;
  bundleId: string;
  productId: string;
  subscriptionGroupIdentifier?: string;
  purchaseDate: number;
  originalPurchaseDate: number;
  expiresDate?: number;
  quantity: number;
  type: AppleTransactionType;
  appAccountToken?: string;
  inAppOwnershipType: AppleOwnershipType;
  signedDate: number;
  revocationReason?: number;
  revocationDate?: number;
  isUpgraded?: boolean;
  offerType?: AppleOfferType;
  offerIdentifier?: string;
  environment: AppleEnvironment;
  storefront: string;
  storefrontId: string;
  transactionReason?: "PURCHASE" | "RENEWAL";
  currency?: string;
  /** Price in micros (1/1,000,000 of the currency unit). */
  price?: number;
}

export interface AppleJwsRenewalInfoPayload {
  originalTransactionId: string;
  autoRenewProductId?: string;
  productId: string;
  autoRenewStatus: 0 | 1;
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  priceIncreaseStatus?: 0 | 1;
  offerType?: AppleOfferType;
  offerIdentifier?: string;
  signedDate: number;
  environment: AppleEnvironment;
  recentSubscriptionStartDate?: number;
  renewalDate?: number;
  currency?: string;
  renewalPrice?: number;
}

export interface AppleResponseBodyV2Data {
  environment: AppleEnvironment;
  bundleId: string;
  bundleVersion?: string;
  appAppleId?: number;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
  status?: number;
}

/**
 * Apple sends this INSTEAD of `data` for EXTERNAL_PURCHASE_TOKEN —
 * `ResponseBodyV2DecodedPayload` documents `data`, `summary` and
 * `externalPurchaseToken` as mutually exclusive, and the payload carries
 * exactly one of them.
 *
 * Note what is NOT here: no transaction, no product, no price, and no
 * identifier that resolves to one of our subscribers. `appAppleId` is the
 * app; `externalPurchaseId` is Apple's opaque id for the purchase. The
 * notification says AN external purchase happened in your app — not whose.
 */
export interface AppleExternalPurchaseToken {
  externalPurchaseId?: string;
  tokenCreationDate?: number;
  appAppleId?: number;
}

export interface AppleResponseBodyV2DecodedPayload {
  notificationType: AppleNotificationType;
  subtype?: AppleNotificationSubtype;
  notificationUUID: string;
  data?: AppleResponseBodyV2Data;
  externalPurchaseToken?: AppleExternalPurchaseToken;
  version: string;
  signedDate: number;
}
