import type { PurchaseStatus, RevenueEventType } from "@rovenue/db";
import {
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GooglePubSubPushBody,
  type GoogleRtdnPayload,
  type GoogleSubscriptionNotificationType,
  type GoogleSubscriptionPurchaseV2,
  type GoogleSubscriptionState,
} from "./google-types";

// Pure transform functions used by the webhook handler. Split
// into its own module so tests can load them without pulling the
// DB package into the runtime graph — the enum types above are
// `import type` only.
//
// The const objects below mirror the pgEnum runtime shape
// (string-valued: e.g. PurchaseStatus.ACTIVE === "ACTIVE"). Keep
// in sync with packages/db/src/drizzle/enums.ts.

const PURCHASE_STATUS = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
  REVOKED: "REVOKED",
  PAUSED: "PAUSED",
  GRACE_PERIOD: "GRACE_PERIOD",
} as const satisfies Record<string, PurchaseStatus>;

const REVENUE_EVENT_TYPE = {
  INITIAL: "INITIAL",
  RENEWAL: "RENEWAL",
  TRIAL_CONVERSION: "TRIAL_CONVERSION",
  CANCELLATION: "CANCELLATION",
  REFUND: "REFUND",
  REACTIVATION: "REACTIVATION",
  CREDIT_PURCHASE: "CREDIT_PURCHASE",
} as const satisfies Record<string, RevenueEventType>;

// =============================================================
// Pub/Sub envelope parsing
// =============================================================

export function parsePushBody(body: GooglePubSubPushBody): GoogleRtdnPayload {
  const dataJson = Buffer.from(body.message.data, "base64").toString("utf8");
  return JSON.parse(dataJson) as GoogleRtdnPayload;
}

export function classifyNotification(payload: GoogleRtdnPayload): string {
  if (payload.subscriptionNotification) {
    return `SUBSCRIPTION_${payload.subscriptionNotification.notificationType}`;
  }
  if (payload.oneTimeProductNotification) {
    return `ONE_TIME_${payload.oneTimeProductNotification.notificationType}`;
  }
  if (payload.voidedPurchaseNotification) {
    return "VOIDED_PURCHASE";
  }
  return "UNKNOWN";
}

// =============================================================
// Subscription state / revenue event mappers
// =============================================================

export function mapStatus(
  state: GoogleSubscriptionState,
  type: GoogleSubscriptionNotificationType,
): PurchaseStatus {
  switch (state) {
    case GOOGLE_SUBSCRIPTION_STATE.ACTIVE:
    case GOOGLE_SUBSCRIPTION_STATE.CANCELED:
      // CANCELED means auto-renew off; access runs until expiry.
      return PURCHASE_STATUS.ACTIVE;
    case GOOGLE_SUBSCRIPTION_STATE.IN_GRACE_PERIOD:
      return PURCHASE_STATUS.GRACE_PERIOD;
    case GOOGLE_SUBSCRIPTION_STATE.ON_HOLD:
    case GOOGLE_SUBSCRIPTION_STATE.PAUSED:
      return PURCHASE_STATUS.PAUSED;
    case GOOGLE_SUBSCRIPTION_STATE.EXPIRED:
      return PURCHASE_STATUS.EXPIRED;
    case GOOGLE_SUBSCRIPTION_STATE.PENDING:
    case GOOGLE_SUBSCRIPTION_STATE.PENDING_PURCHASE_CANCELED:
      return PURCHASE_STATUS.TRIAL;
    default:
      if (type === GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED) {
        return PURCHASE_STATUS.REVOKED;
      }
      return PURCHASE_STATUS.ACTIVE;
  }
}

export function mapRevenueEventType(
  type: GoogleSubscriptionNotificationType,
): RevenueEventType | null {
  switch (type) {
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED:
      return REVENUE_EVENT_TYPE.INITIAL;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED:
      return REVENUE_EVENT_TYPE.RENEWAL;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED:
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED:
      return REVENUE_EVENT_TYPE.REACTIVATION;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED:
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED:
      return REVENUE_EVENT_TYPE.CANCELLATION;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED:
      return REVENUE_EVENT_TYPE.REFUND;
    default:
      return null;
  }
}

const ENTITLEMENT_GRANTING_STATUSES: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>([
  PURCHASE_STATUS.ACTIVE,
  PURCHASE_STATUS.TRIAL,
  PURCHASE_STATUS.GRACE_PERIOD,
]);

export function isEntitlementGranting(status: PurchaseStatus): boolean {
  return ENTITLEMENT_GRANTING_STATUSES.has(status);
}

export function extractCancelTime(
  purchase: GoogleSubscriptionPurchaseV2,
): Date | null {
  const cancelTime =
    purchase.canceledStateContext?.userInitiatedCancellation?.cancelTime;
  return cancelTime ? new Date(cancelTime) : null;
}
