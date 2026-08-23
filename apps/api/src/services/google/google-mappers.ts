import type { PurchaseStatus, RevenueEventType } from "@rovenue/db";
import { logger } from "../../lib/logger";
import {
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GooglePubSubPushBody,
  type GoogleRtdnPayload,
  type GoogleSubscriptionNotificationType,
  type GoogleSubscriptionPurchaseLineItem,
  type GoogleSubscriptionPurchaseV2,
  type GoogleSubscriptionState,
} from "./google-types";

const log = logger.child("google-mappers");

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

/**
 * Map a Google `subscriptionState` alone to a purchase status. Shared by the
 * RTDN webhook ({@link mapStatus}, which layers the REVOKED override on top)
 * and the receipt-verify path, so both paths agree on which store states
 * grant access.
 */
export function mapSubscriptionStateToStatus(
  state: GoogleSubscriptionState,
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
      // Payment has not completed — never access-granting. When (if) the
      // user pays, Google emits a fresh RTDN in a paid state, which
      // re-activates the row.
      return PURCHASE_STATUS.EXPIRED;
    default:
      // Fail closed: an unrecognized state must never grant access.
      log.warn("unrecognized Google subscription state; defaulting to EXPIRED", {
        state,
      });
      return PURCHASE_STATUS.EXPIRED;
  }
}

export function mapStatus(
  state: GoogleSubscriptionState,
  type: GoogleSubscriptionNotificationType,
): PurchaseStatus {
  // A revoke is a distinct terminal state from a natural expiry. Google's
  // subscriptionsv2.get usually returns state=EXPIRED for a revoked
  // subscription, which would otherwise collapse REVOKED into EXPIRED and
  // lose the chargeback/policy distinction in analytics. Honor the
  // notification type first.
  if (type === GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED) {
    return PURCHASE_STATUS.REVOKED;
  }
  return mapSubscriptionStateToStatus(state);
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

const ACCESS_GRANTING_STATUSES: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>([
  PURCHASE_STATUS.ACTIVE,
  PURCHASE_STATUS.TRIAL,
  PURCHASE_STATUS.GRACE_PERIOD,
]);

export function isAccessGranting(status: PurchaseStatus): boolean {
  return ACCESS_GRANTING_STATUSES.has(status);
}

export function extractCancelTime(
  purchase: GoogleSubscriptionPurchaseV2,
): Date | null {
  const cancelTime =
    purchase.canceledStateContext?.userInitiatedCancellation?.cancelTime;
  return cancelTime ? new Date(cancelTime) : null;
}

// =============================================================
// Order id extraction
// =============================================================

/**
 * The ONE place an order id is extracted from a SubscriptionPurchaseV2.
 * The v2 response carries it per line item as `latestSuccessfulOrderId`;
 * the top-level `latestOrderId` is deprecated but still populated on
 * older responses, so it remains the fallback. Returns `undefined` when
 * Google sent neither — callers fall back to the purchaseToken when
 * building revenue dedupe keys.
 */
export function effectiveGoogleOrderId(
  purchase: Pick<GoogleSubscriptionPurchaseV2, "latestOrderId">,
  lineItem:
    | Pick<GoogleSubscriptionPurchaseLineItem, "latestSuccessfulOrderId">
    | undefined,
): string | undefined {
  return lineItem?.latestSuccessfulOrderId ?? purchase.latestOrderId;
}

/**
 * Google appends a `..N` suffix to a subscription's order id for each
 * renewal period (`GPA.xxxx-xxxx-xxxx-xxxxx..0` is the first renewal);
 * the bare id is the initial order. Lets the receipt-verify path — which
 * has no RTDN notificationType to classify from — label a revenue event
 * INITIAL vs RENEWAL from the order id alone.
 */
const GOOGLE_RENEWAL_ORDER_ID_SUFFIX = /\.\.\d+$/;

export function isGoogleRenewalOrderId(orderId: string): boolean {
  return GOOGLE_RENEWAL_ORDER_ID_SUFFIX.test(orderId);
}
