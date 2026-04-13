// =============================================================
// Google Play Real-time Developer Notifications — enums
// https://developer.android.com/google/play/billing/rtdn-reference
// =============================================================

export const GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE = {
  SUBSCRIPTION_RECOVERED: 1,
  SUBSCRIPTION_RENEWED: 2,
  SUBSCRIPTION_CANCELED: 3,
  SUBSCRIPTION_PURCHASED: 4,
  SUBSCRIPTION_ON_HOLD: 5,
  SUBSCRIPTION_IN_GRACE_PERIOD: 6,
  SUBSCRIPTION_RESTARTED: 7,
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: 8,
  SUBSCRIPTION_DEFERRED: 9,
  SUBSCRIPTION_PAUSED: 10,
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED: 11,
  SUBSCRIPTION_REVOKED: 12,
  SUBSCRIPTION_EXPIRED: 13,
  SUBSCRIPTION_PENDING_PURCHASE_CANCELED: 20,
} as const;
export type GoogleSubscriptionNotificationType =
  (typeof GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE)[keyof typeof GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE];

export const GOOGLE_ONE_TIME_PRODUCT_NOTIFICATION_TYPE = {
  ONE_TIME_PRODUCT_PURCHASED: 1,
  ONE_TIME_PRODUCT_CANCELED: 2,
} as const;
export type GoogleOneTimeProductNotificationType =
  (typeof GOOGLE_ONE_TIME_PRODUCT_NOTIFICATION_TYPE)[keyof typeof GOOGLE_ONE_TIME_PRODUCT_NOTIFICATION_TYPE];

export const GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE = {
  PRODUCT_TYPE_SUBSCRIPTION: 1,
  PRODUCT_TYPE_ONE_TIME: 2,
} as const;
export type GoogleVoidedPurchaseProductType =
  (typeof GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE)[keyof typeof GOOGLE_VOIDED_PURCHASE_PRODUCT_TYPE];

export const GOOGLE_VOIDED_PURCHASE_REFUND_TYPE = {
  REFUND_TYPE_FULL_REFUND: 1,
  REFUND_TYPE_QUANTITY_BASED_PARTIAL_REFUND: 2,
} as const;
export type GoogleVoidedPurchaseRefundType =
  (typeof GOOGLE_VOIDED_PURCHASE_REFUND_TYPE)[keyof typeof GOOGLE_VOIDED_PURCHASE_REFUND_TYPE];

// =============================================================
// SubscriptionPurchaseV2 — purchases.subscriptionsv2.get response
// =============================================================

export const GOOGLE_SUBSCRIPTION_STATE = {
  UNSPECIFIED: "SUBSCRIPTION_STATE_UNSPECIFIED",
  PENDING: "SUBSCRIPTION_STATE_PENDING",
  ACTIVE: "SUBSCRIPTION_STATE_ACTIVE",
  PAUSED: "SUBSCRIPTION_STATE_PAUSED",
  IN_GRACE_PERIOD: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  ON_HOLD: "SUBSCRIPTION_STATE_ON_HOLD",
  CANCELED: "SUBSCRIPTION_STATE_CANCELED",
  EXPIRED: "SUBSCRIPTION_STATE_EXPIRED",
  PENDING_PURCHASE_CANCELED: "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
} as const;
export type GoogleSubscriptionState =
  (typeof GOOGLE_SUBSCRIPTION_STATE)[keyof typeof GOOGLE_SUBSCRIPTION_STATE];

export const GOOGLE_ACKNOWLEDGEMENT_STATE = {
  UNSPECIFIED: "ACKNOWLEDGEMENT_STATE_UNSPECIFIED",
  PENDING: "ACKNOWLEDGEMENT_STATE_PENDING",
  ACKNOWLEDGED: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
} as const;
export type GoogleAcknowledgementState =
  (typeof GOOGLE_ACKNOWLEDGEMENT_STATE)[keyof typeof GOOGLE_ACKNOWLEDGEMENT_STATE];

// =============================================================
// Service account credentials (subset of the downloaded JSON)
// =============================================================

export interface GoogleServiceAccountCredentials {
  type?: "service_account";
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
}

// =============================================================
// Pub/Sub push envelope
// =============================================================

export interface GooglePubSubMessage {
  data: string;
  messageId: string;
  publishTime: string;
  attributes?: Record<string, string>;
}

export interface GooglePubSubPushBody {
  message: GooglePubSubMessage;
  subscription: string;
}

// =============================================================
// Decoded RTDN payload
// =============================================================

export interface GoogleRtdnSubscriptionNotification {
  version: string;
  notificationType: GoogleSubscriptionNotificationType;
  purchaseToken: string;
  subscriptionId: string;
}

export interface GoogleRtdnOneTimeProductNotification {
  version: string;
  notificationType: GoogleOneTimeProductNotificationType;
  purchaseToken: string;
  sku: string;
}

export interface GoogleRtdnVoidedPurchaseNotification {
  purchaseToken: string;
  orderId: string;
  productType: GoogleVoidedPurchaseProductType;
  refundType: GoogleVoidedPurchaseRefundType;
}

export interface GoogleRtdnTestNotification {
  version: string;
}

export interface GoogleRtdnPayload {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: GoogleRtdnSubscriptionNotification;
  oneTimeProductNotification?: GoogleRtdnOneTimeProductNotification;
  voidedPurchaseNotification?: GoogleRtdnVoidedPurchaseNotification;
  testNotification?: GoogleRtdnTestNotification;
}

// =============================================================
// SubscriptionPurchaseV2 (trimmed to fields we consume)
// =============================================================

export interface GoogleSubscriptionPurchaseLineItem {
  productId: string;
  expiryTime: string;
  autoRenewingPlan?: {
    autoRenewEnabled?: boolean;
  };
  prepaidPlan?: {
    allowExtendAfterTime?: string;
  };
  offerDetails?: {
    basePlanId: string;
    offerId?: string;
    offerTags?: string[];
  };
}

export interface GoogleSubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  lineItems?: GoogleSubscriptionPurchaseLineItem[];
  startTime?: string;
  subscriptionState: GoogleSubscriptionState;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  pausedStateContext?: {
    autoResumeTime?: string;
  };
  canceledStateContext?: {
    userInitiatedCancellation?: {
      cancelTime?: string;
    };
    systemInitiatedCancellation?: Record<string, unknown>;
    developerInitiatedCancellation?: Record<string, unknown>;
    replacementCancellation?: Record<string, unknown>;
  };
  testPurchase?: Record<string, unknown>;
  acknowledgementState: GoogleAcknowledgementState;
  externalAccountIdentifiers?: {
    externalAccountId?: string;
    obfuscatedExternalAccountId?: string;
    obfuscatedExternalProfileId?: string;
  };
}
