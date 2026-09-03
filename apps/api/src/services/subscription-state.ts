import type { PurchaseStatus } from "@rovenue/db";
import type Stripe from "stripe";
import {
  SUBSCRIPTION_STATUS_SEMANTICS,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@rovenue/shared/subscription-status";
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

// Type-safe mirror of the PurchaseStatus enum, built from the shared
// tuple. `import type` still keeps the DB package out of this module's
// runtime graph.
const STATUS = Object.fromEntries(
  SUBSCRIPTION_STATUSES.map((s) => [s, s]),
) as { [K in SubscriptionStatus]: K };

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
      // Apple sends subtype GRACE_PERIOD only when the app has a billing
      // grace period configured — that is the case where the subscriber
      // keeps access during the retry. Without it the subscription has
      // already lapsed on Apple's side and the user has NO access, so
      // reporting GRACE_PERIOD here (the pre-2026-09-03 "OD-1" choice)
      // granted entitlement Apple itself had withdrawn. (Task 4,
      // 2026-09-04.)
      return subtype === APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD
        ? STATUS.GRACE_PERIOD
        : STATUS.BILLING_ISSUE;
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
      // Account hold: Google suspended the subscription after the grace
      // window closed. Access is gone, and — unlike PAUSED — the user
      // did not choose this, so dunning applies. (Task 4, 2026-09-04.)
      return STATUS.BILLING_ISSUE;
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
      // Smart retries are running and Stripe keeps the subscription
      // usable — access is retained. (Task 4, 2026-09-04.)
      return STATUS.GRACE_PERIOD;
    case STRIPE_SUBSCRIPTION_STATUS.UNPAID:
    case STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE:
      return STATUS.BILLING_ISSUE;
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
      STATUS.BILLING_ISSUE,
    ]),
    [STATUS.ACTIVE]: new Set<PurchaseStatus>([
      STATUS.ACTIVE,
      STATUS.TRIAL,
      STATUS.GRACE_PERIOD,
      STATUS.EXPIRED,
      STATUS.REFUNDED,
      STATUS.REVOKED,
      STATUS.PAUSED,
      STATUS.BILLING_ISSUE,
    ]),
    [STATUS.GRACE_PERIOD]: new Set<PurchaseStatus>([
      STATUS.GRACE_PERIOD,
      STATUS.ACTIVE,
      STATUS.EXPIRED,
      STATUS.REFUNDED,
      STATUS.REVOKED,
      // The retry window closed without a successful charge and the
      // store dropped access: grace (retry WITH access) hands off to
      // the involuntary suspension.
      STATUS.BILLING_ISSUE,
    ]),
    // Involuntary suspension. Recovers to ACTIVE when the store finally
    // collects, lapses to EXPIRED when the hold runs out, and can be cut
    // short by either terminal status. Deliberately NO edge to PAUSED:
    // PAUSED is the user's own choice, and letting a dunning row slide
    // into it would relabel involuntary churn as voluntary.
    [STATUS.BILLING_ISSUE]: new Set<PurchaseStatus>([
      STATUS.BILLING_ISSUE,
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

// =============================================================
// Transition guard — applied at every ingestion status write
// =============================================================

export interface TransitionDecision {
  /** true when the status write should be applied. */
  apply: boolean;
  from: PurchaseStatus | null;
  to: PurchaseStatus;
}

/**
 * Decides whether `to` may be written given the current `from`.
 * A null `from` (row not yet present) is always allowed (first insert).
 */
export function decideTransition(
  from: PurchaseStatus | null,
  to: PurchaseStatus,
): TransitionDecision {
  if (from === null) return { apply: true, from, to };
  return { apply: validateTransition(from, to), from, to };
}

// =============================================================
// Billing-issue stamp — column patch for every ingestion path
// =============================================================

/**
 * Column patch for `purchases.billingIssueDetectedAt`, spread into the
 * guarded update by every ingestion path (Apple, Google, Stripe). Stamped
 * on ENTRY only (so a repeated ON_HOLD/BILLING_RETRY/unpaid signal doesn't
 * reset a dunning campaign's clock) and cleared only when the subscription
 * recovers into a status that grants access again. A lapse to EXPIRED
 * keeps the stamp — that is the evidence the churn was involuntary.
 */
export function billingIssueStamp(
  from: PurchaseStatus | null,
  to: PurchaseStatus,
  now: Date,
): { billingIssueDetectedAt?: Date | null } {
  if (to === STATUS.BILLING_ISSUE) {
    return from === STATUS.BILLING_ISSUE ? {} : { billingIssueDetectedAt: now };
  }
  if (
    from === STATUS.BILLING_ISSUE &&
    SUBSCRIPTION_STATUS_SEMANTICS[to].grantsAccess
  ) {
    return { billingIssueDetectedAt: null };
  }
  return {};
}
