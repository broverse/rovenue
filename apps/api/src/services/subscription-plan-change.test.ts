import { RevenueEventType } from "@rovenue/db";
import { describe, expect, it } from "vitest";
import {
  applePlanChangeType,
  pendingPlanChangeFields,
} from "./subscription-plan-change";

describe("applePlanChangeType", () => {
  it("reads the direction straight off Apple's subtype", () => {
    expect(applePlanChangeType("UPGRADE")).toBe("UPGRADE");
    expect(applePlanChangeType("DOWNGRADE")).toBe("DOWNGRADE");
  });

  it("returns null for a subtype that carries no direction", () => {
    expect(applePlanChangeType(undefined)).toBeNull();
    expect(applePlanChangeType("BILLING_RECOVERY")).toBeNull();
  });
});

describe("pendingPlanChangeFields", () => {
  const EFFECTIVE_AT = new Date("2026-10-01T00:00:00.000Z");

  it("records a store-announced change that has not taken effect yet", () => {
    expect(
      pendingPlanChangeFields({
        writtenProductId: "prod_basic",
        announcedProductId: "prod_pro",
        changeType: "UPGRADE",
        effectiveAt: EFFECTIVE_AT,
      }),
    ).toEqual({
      pendingProductId: "prod_pro",
      pendingChangeType: "UPGRADE",
      pendingChangeEffectiveAt: EFFECTIVE_AT,
    });
  });

  it("clears the pending columns once the announced product is the written one", () => {
    // The change took effect: the row now carries the product it was
    // pending on, so there is nothing pending any more.
    expect(
      pendingPlanChangeFields({
        writtenProductId: "prod_pro",
        announcedProductId: "prod_pro",
        changeType: "UPGRADE",
        effectiveAt: EFFECTIVE_AT,
      }),
    ).toEqual({
      pendingProductId: null,
      pendingChangeType: null,
      pendingChangeEffectiveAt: null,
    });
  });

  it("clears the pending columns when the store announces nothing", () => {
    // A reverted change: the store stops naming a future product, and the
    // fields are rewritten from live store state on every sync, so the
    // revert clears itself without a second read.
    expect(
      pendingPlanChangeFields({
        writtenProductId: "prod_basic",
        announcedProductId: null,
        changeType: null,
        effectiveAt: EFFECTIVE_AT,
      }),
    ).toEqual({
      pendingProductId: null,
      pendingChangeType: null,
      pendingChangeEffectiveAt: null,
    });
  });
});

// Spec §4.6: an upgrade must NOT invent a proration revenue type. Apple
// sends the prorated refund as its own REFUND notification, Stripe puts
// proration lines on the invoice the existing path reads, and Google's
// replacement token carries the real priceAmountMicros — so net revenue
// is already correct and a new enum value would reach ClickHouse for
// nothing. This pins the decision: adding a member here is a deliberate
// act that fails this test first.
//
// It has fired once, as designed. `NON_RENEWING_PURCHASE` was added by the
// repo owner in `256d1eb2` for one-time (non-subscription) purchases, and
// it is NOT a proration type: it classifies a charge that has no renewal
// cycle at all, whereas a proration type would classify the *difference*
// between two subscription prices at a plan switch. Admitting it here keeps
// the pin meaning exactly what it was written to mean — a new member that
// IS proration-shaped still has to argue for itself in this list first.
describe("proration revenue invariant", () => {
  it("records no proration-specific revenue event type", () => {
    expect(Object.keys(RevenueEventType).sort()).toEqual([
      "CANCELLATION",
      "CREDIT_PURCHASE",
      "INITIAL",
      "NON_RENEWING_PURCHASE",
      "REACTIVATION",
      "REFUND",
      "RENEWAL",
      "TRIAL_CONVERSION",
    ]);
  });
});
