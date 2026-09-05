import { describe, expect, it } from "vitest";
import {
  ROVENUE_EVENT_KEYS,
  isRovenueEventKey,
  STANDARD_PROVIDER_EVENT_KEYS,
  SUBSCRIPTION_BRIDGE_EVENT_KEYS,
  SUBSCRIPTION_LIFECYCLE_KEYS,
  WEBHOOK_API_VERSION,
  type RovenueEventKey,
} from "./integrations";

describe("RovenueEventKey", () => {
  it("includes all 23 canonical keys (v2, Wave-1 + 2026-09-03 paused/recovered/revoked/offer_redeemed + 2026-09-04 non_renewing_purchase/reactivation)", () => {
    expect(ROVENUE_EVENT_KEYS).toEqual([
      "revenue.INITIAL",
      "revenue.TRIAL_CONVERSION",
      "revenue.RENEWAL",
      "revenue.CREDIT_PURCHASE",
      "revenue.NON_RENEWING_PURCHASE",
      "revenue.REACTIVATION",
      "revenue.REFUND",
      "revenue.CANCELLATION",
      "subscription.trial.started",
      "subscriber.identified",
      "subscription.cancel_requested",
      "subscription.expired",
      "subscription.billing_issue",
      "subscription.grace_period",
      "subscription.uncancelled",
      "subscription.product_changed",
      "subscription.paused",
      "subscription.recovered",
      "subscription.revoked",
      "subscription.offer_redeemed",
      "paywall.view",
      "paywall.close",
      "credit.ledger.appended",
    ]);
  });

  it("type-guards a string into RovenueEventKey", () => {
    const candidate = "revenue.RENEWAL";
    expect(isRovenueEventKey(candidate)).toBe(true);
    if (isRovenueEventKey(candidate)) {
      const _t: RovenueEventKey = candidate;
      expect(_t).toBe("revenue.RENEWAL");
    }
  });

  it("recognizes v2 public event keys", () => {
    expect(isRovenueEventKey("paywall.view")).toBe(true);
    expect(isRovenueEventKey("paywall.close")).toBe(true);
    expect(isRovenueEventKey("subscription.cancel_requested")).toBe(true);
    expect(isRovenueEventKey("subscription.expired")).toBe(true);
    expect(isRovenueEventKey("credit.ledger.appended")).toBe(true);
  });

  it("recognizes the Wave-1 store-lifecycle normalization keys", () => {
    expect(isRovenueEventKey("subscription.billing_issue")).toBe(true);
    expect(isRovenueEventKey("subscription.grace_period")).toBe(true);
    expect(isRovenueEventKey("subscription.uncancelled")).toBe(true);
    expect(isRovenueEventKey("subscription.product_changed")).toBe(true);
  });

  it("recognizes subscription.offer_redeemed (Apple OFFER_REDEEMED, 2026-09-03)", () => {
    expect(isRovenueEventKey("subscription.offer_redeemed")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isRovenueEventKey("revenue.UNKNOWN")).toBe(false);
    expect(isRovenueEventKey("billing.invoice.paid")).toBe(false);
    expect(isRovenueEventKey("")).toBe(false);
  });

  it("WEBHOOK_API_VERSION matches date format YYYY-MM-DD", () => {
    expect(WEBHOOK_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(WEBHOOK_API_VERSION).toBe("2026-08-24");
  });
});

// ---------------------------------------------------------------------------
// Subset containment
// ---------------------------------------------------------------------------
//
// The subsets are what widen every provider's advertised catalog, and a key
// present in one but not the next is exactly the drift that ships a key
// nothing can deliver. `satisfies` already proves each subset's members are
// real catalog keys; these prove the CHAIN — bridge ⊂ lifecycle ⊂ standard ⊂
// catalog — which `satisfies` does not.

describe("event-key subsets", () => {
  it("every bridge key is a catalog key, a lifecycle key and a standard-provider key", () => {
    for (const key of SUBSCRIPTION_BRIDGE_EVENT_KEYS) {
      expect(isRovenueEventKey(key), key).toBe(true);
      expect(SUBSCRIPTION_LIFECYCLE_KEYS, key).toContain(key);
      expect(STANDARD_PROVIDER_EVENT_KEYS, key).toContain(key);
    }
  });

  it("carries subscription.offer_redeemed all the way through to the standard catalog", () => {
    // Named explicitly rather than left to the loop above: this key is the
    // one that had no handler at all, and the whole point of adding it is
    // that it reaches the providers.
    expect(SUBSCRIPTION_BRIDGE_EVENT_KEYS).toContain("subscription.offer_redeemed");
    expect(STANDARD_PROVIDER_EVENT_KEYS).toContain("subscription.offer_redeemed");
  });
});
