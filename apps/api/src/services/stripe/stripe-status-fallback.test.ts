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
