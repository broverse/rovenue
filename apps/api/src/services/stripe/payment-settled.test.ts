import { describe, expect, it } from "vitest";
import { hasPaidOrAttachedACard } from "./payment-settled";

// =============================================================
// The one place "has this buyer paid?" is answered
// =============================================================
//
// Both the browser's /confirm and the Connect webhook's backstop mint a
// claim token off this answer, so it is pinned here once rather than in
// each caller's suite. The callers' own suites assert that they call
// THIS function; what the function says is decided below.

describe("hasPaidOrAttachedACard", () => {
  it("counts an active subscription as settled", () => {
    expect(hasPaidOrAttachedACard({ status: "active" })).toBe(true);
  });

  // An active subscription has a paid invoice behind it; the payment
  // method may live on the customer rather than the subscription.
  it("counts an active subscription with no default payment method", () => {
    expect(
      hasPaidOrAttachedACard({ status: "active", default_payment_method: null }),
    ).toBe(true);
  });

  // THE bug this module exists for. Stripe parks a trial package's
  // subscription at `trialing` the moment the visitor picks it — before
  // the card form is even filled in.
  it("does NOT count a trialing subscription with no payment method", () => {
    expect(
      hasPaidOrAttachedACard({
        status: "trialing",
        default_payment_method: null,
      }),
    ).toBe(false);
  });

  it("does NOT count a trialing subscription whose field is absent", () => {
    expect(hasPaidOrAttachedACard({ status: "trialing" })).toBe(false);
  });

  it("counts a trialing subscription once a card is attached", () => {
    expect(
      hasPaidOrAttachedACard({
        status: "trialing",
        default_payment_method: "pm_1",
      }),
    ).toBe(true);
  });

  // Expanded rather than a bare id: still a card.
  it("counts an expanded payment method object", () => {
    expect(
      hasPaidOrAttachedACard({
        status: "trialing",
        default_payment_method: { id: "pm_1" } as never,
      }),
    ).toBe(true);
  });

  it.each([
    "incomplete",
    "incomplete_expired",
    "past_due",
    "unpaid",
    "canceled",
    "paused",
  ] as const)("does NOT count a %s subscription", (status) => {
    expect(
      hasPaidOrAttachedACard({ status, default_payment_method: "pm_1" }),
    ).toBe(false);
  });
});
