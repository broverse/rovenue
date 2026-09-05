// =============================================================
// subscription-state — the transition machine
// =============================================================
//
// This module owns the ALLOWED-TRANSITION graph and the billing-issue
// stamp. It deliberately owns NO store-status mapping.
//
// It used to export `normalizeAppleStatus` / `normalizeGoogleStatus` /
// `normalizeStripeStatus` and a `normalizeStatus` dispatcher over them.
// Nothing in production ever called any of the four: the live mappings
// live where the store payload is parsed — inline in
// `apple/apple-webhook.ts`, in `google/google-mappers.ts`, and in
// `stripe/stripe-webhook.ts`'s `mapStripeSubscriptionStatus` (which
// `import/verify-store-clients.ts` and `receipt-verify.ts` reuse rather
// than copy). Keeping a parallel, unreachable set here meant a SECOND
// status vocabulary that only its own unit tests could ever disagree
// with — a mapping change made in one place and not the other would have
// been invisible until someone wired the dead copy up. They were deleted
// on 2026-09-05 (Task 15); the behaviour they asserted is pinned against
// the live mappers in `apple/apple-webhook.failed-renewal.test.ts`,
// `tests/google-webhook.test.ts` and
// `stripe/stripe-status-fallback.test.ts`.

import type { PurchaseStatus } from "@rovenue/db";
import {
  SUBSCRIPTION_STATUS_SEMANTICS,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@rovenue/shared/subscription-status";

// Type-safe mirror of the PurchaseStatus enum, built from the shared
// tuple. `import type` still keeps the DB package out of this module's
// runtime graph.
const STATUS = Object.fromEntries(
  SUBSCRIPTION_STATUSES.map((s) => [s, s]),
) as { [K in SubscriptionStatus]: K };

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
