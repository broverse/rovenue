import type { PurchaseStatus } from "@rovenue/db";
import type Stripe from "stripe";
import {
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  type AppleNotificationSubtype,
  type AppleNotificationType,
} from "./apple/apple-types";
import {
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GoogleSubscriptionNotificationType,
  type GoogleSubscriptionState,
} from "./google/google-types";
import { STRIPE_SUBSCRIPTION_STATUS } from "./stripe/stripe-types";

// Type-safe mirror of the PurchaseStatus enum. `import type` keeps
// the DB package out of this module's runtime graph so tests and
// tooling can load the state machine without DB initialization.
const STATUS = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
  REVOKED: "REVOKED",
  PAUSED: "PAUSED",
  GRACE_PERIOD: "GRACE_PERIOD",
} as const satisfies Record<string, PurchaseStatus>;

// =============================================================
// Per-store normalizers
// =============================================================

export function normalizeAppleStatus(
  notificationType: AppleNotificationType,
  subtype?: AppleNotificationSubtype,
): PurchaseStatus {
  switch (notificationType) {
    case APPLE_NOTIFICATION_TYPE.SUBSCRIBED:
      return subtype === APPLE_NOTIFICATION_SUBTYPE.INITIAL_BUY
        ? STATUS.ACTIVE
        : STATUS.ACTIVE;
    case APPLE_NOTIFICATION_TYPE.DID_RENEW:
      return STATUS.ACTIVE;
    case APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW:
      return subtype === APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD
        ? STATUS.GRACE_PERIOD
        : STATUS.ACTIVE;
    case APPLE_NOTIFICATION_TYPE.GRACE_PERIOD_EXPIRED:
    case APPLE_NOTIFICATION_TYPE.EXPIRED:
      return STATUS.EXPIRED;
    case APPLE_NOTIFICATION_TYPE.REFUND:
      return STATUS.REFUNDED;
    case APPLE_NOTIFICATION_TYPE.REVOKE:
      return STATUS.REVOKED;
    case APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_STATUS:
    case APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_PREF:
    default:
      return STATUS.ACTIVE;
  }
}

export function normalizeGoogleStatus(
  state: GoogleSubscriptionState,
  notificationType?: GoogleSubscriptionNotificationType,
): PurchaseStatus {
  switch (state) {
    case GOOGLE_SUBSCRIPTION_STATE.ACTIVE:
    case GOOGLE_SUBSCRIPTION_STATE.CANCELED:
      // CANCELED means auto-renew off; access runs until expiry.
      return STATUS.ACTIVE;
    case GOOGLE_SUBSCRIPTION_STATE.IN_GRACE_PERIOD:
      return STATUS.GRACE_PERIOD;
    case GOOGLE_SUBSCRIPTION_STATE.ON_HOLD:
    case GOOGLE_SUBSCRIPTION_STATE.PAUSED:
      return STATUS.PAUSED;
    case GOOGLE_SUBSCRIPTION_STATE.EXPIRED:
      return STATUS.EXPIRED;
    case GOOGLE_SUBSCRIPTION_STATE.PENDING:
    case GOOGLE_SUBSCRIPTION_STATE.PENDING_PURCHASE_CANCELED:
      return STATUS.TRIAL;
    default:
      if (
        notificationType ===
        GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED
      ) {
        return STATUS.REVOKED;
      }
      return STATUS.ACTIVE;
  }
}

export function normalizeStripeStatus(
  status: Stripe.Subscription.Status,
): PurchaseStatus {
  switch (status) {
    case STRIPE_SUBSCRIPTION_STATUS.ACTIVE:
      return STATUS.ACTIVE;
    case STRIPE_SUBSCRIPTION_STATUS.TRIALING:
      return STATUS.TRIAL;
    case STRIPE_SUBSCRIPTION_STATUS.PAST_DUE:
    case STRIPE_SUBSCRIPTION_STATUS.UNPAID:
    case STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE:
      return STATUS.GRACE_PERIOD;
    case STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED:
    case STRIPE_SUBSCRIPTION_STATUS.CANCELED:
      return STATUS.EXPIRED;
    case STRIPE_SUBSCRIPTION_STATUS.PAUSED:
      return STATUS.PAUSED;
    default:
      return STATUS.ACTIVE;
  }
}

// =============================================================
// Generic dispatcher
// =============================================================

export type NormalizeStatusArgs =
  | {
      store: "APP_STORE";
      notificationType: AppleNotificationType;
      subtype?: AppleNotificationSubtype;
    }
  | {
      store: "PLAY_STORE";
      state: GoogleSubscriptionState;
      notificationType?: GoogleSubscriptionNotificationType;
    }
  | {
      store: "STRIPE";
      status: Stripe.Subscription.Status;
    };

export function normalizeStatus(args: NormalizeStatusArgs): PurchaseStatus {
  switch (args.store) {
    case "APP_STORE":
      return normalizeAppleStatus(args.notificationType, args.subtype);
    case "PLAY_STORE":
      return normalizeGoogleStatus(args.state, args.notificationType);
    case "STRIPE":
      return normalizeStripeStatus(args.status);
  }
}

// =============================================================
// State machine — allowed transitions
// =============================================================

const TRANSITIONS: Readonly<Record<PurchaseStatus, ReadonlySet<PurchaseStatus>>> =
  {
    [STATUS.TRIAL]: new Set<PurchaseStatus>([
      STATUS.TRIAL,
      STATUS.ACTIVE,
      STATUS.EXPIRED,
      STATUS.REVOKED,
      STATUS.REFUNDED,
    ]),
    [STATUS.ACTIVE]: new Set<PurchaseStatus>([
      STATUS.ACTIVE,
      STATUS.TRIAL,
      STATUS.GRACE_PERIOD,
      STATUS.EXPIRED,
      STATUS.REFUNDED,
      STATUS.REVOKED,
      STATUS.PAUSED,
    ]),
    [STATUS.GRACE_PERIOD]: new Set<PurchaseStatus>([
      STATUS.GRACE_PERIOD,
      STATUS.ACTIVE,
      STATUS.EXPIRED,
      STATUS.REFUNDED,
      STATUS.REVOKED,
    ]),
    [STATUS.PAUSED]: new Set<PurchaseStatus>([
      STATUS.PAUSED,
      STATUS.ACTIVE,
      STATUS.EXPIRED,
      STATUS.REVOKED,
    ]),
    [STATUS.EXPIRED]: new Set<PurchaseStatus>([
      STATUS.EXPIRED,
      STATUS.ACTIVE,
      STATUS.TRIAL,
    ]),
    [STATUS.REFUNDED]: new Set<PurchaseStatus>([STATUS.REFUNDED]),
    [STATUS.REVOKED]: new Set<PurchaseStatus>([STATUS.REVOKED]),
  };

export function validateTransition(
  from: PurchaseStatus,
  to: PurchaseStatus,
): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function allowedTransitions(
  from: PurchaseStatus,
): ReadonlySet<PurchaseStatus> {
  return TRANSITIONS[from] ?? new Set();
}
