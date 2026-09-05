import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { mapStripeSubscriptionStatus } from "./stripe-webhook";
import { PurchaseStatus } from "@rovenue/db";

// =============================================================
// The unknown-status fallback
// =============================================================
//
// This branch is UNREACHABLE today: Stripe's SDK union declares exactly
// the eight statuses the mapper names. It exists for the day Stripe adds
// a ninth and the pinned SDK is upgraded — a routine dependency bump,
// long after anyone remembers this code.
//
// Before this change it returned PurchaseStatus.ACTIVE, silently granting
// full entitlement to a state we do not understand, with no log.

const UNKNOWN = "some_status_stripe_added_later" as Stripe.Subscription.Status;

describe("mapStripeSubscriptionStatus — unknown status", () => {
  it("returns null rather than a guessed status", () => {
    expect(mapStripeSubscriptionStatus(UNKNOWN)).toBeNull();
  });

  it("does NOT return any status that grants entitlement", () => {
    // access-engine.ts grants access for ACTIVE, TRIAL and GRACE_PERIOD.
    // Returning any of them here would be a fail-open — a shorter one for
    // GRACE_PERIOD, but a fail-open all the same.
    const granting = [
      PurchaseStatus.ACTIVE,
      PurchaseStatus.TRIAL,
      PurchaseStatus.GRACE_PERIOD,
    ];
    expect(granting).not.toContain(mapStripeSubscriptionStatus(UNKNOWN));
  });

  it("still maps every status Stripe documents today", () => {
    // If this fails after an SDK bump, Stripe added a status — which is
    // precisely the event the null branch exists for. Add the mapping.
    const documented: Stripe.Subscription.Status[] = [
      "active",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "past_due",
      "paused",
      "trialing",
      "unpaid",
    ];
    for (const s of documented) {
      expect(mapStripeSubscriptionStatus(s), `status ${s}`).not.toBeNull();
    }
  });
});

// =============================================================
// The retrying/not-paying split (Task 4, 2026-09-04)
// =============================================================
//
// Two Stripe statuses both mean "the last invoice is unpaid" and they must
// NOT collapse into one purchase status: while `past_due` runs, smart
// retries are live and Stripe still treats the subscription as usable, so
// access is retained; `unpaid` means the retry schedule is exhausted and
// `incomplete` means the very first invoice never cleared, and in neither
// case does Stripe consider the customer subscribed.
//
// These three assertions lived on the dead `normalizeStripeStatus` helper
// until 2026-09-05 (Task 15), where they pinned a mapping no request ever
// reached. They are here now, on the function the webhook and the import
// re-verification both call.
describe("mapStripeSubscriptionStatus — retrying vs. not paying", () => {
  it("keeps a retrying subscription in GRACE_PERIOD", () => {
    expect(mapStripeSubscriptionStatus("past_due")).toBe(
      PurchaseStatus.GRACE_PERIOD,
    );
  });

  it("routes exhausted retries and an unpaid first invoice to BILLING_ISSUE", () => {
    expect(mapStripeSubscriptionStatus("unpaid")).toBe(
      PurchaseStatus.BILLING_ISSUE,
    );
    expect(mapStripeSubscriptionStatus("incomplete")).toBe(
      PurchaseStatus.BILLING_ISSUE,
    );
  });
});
