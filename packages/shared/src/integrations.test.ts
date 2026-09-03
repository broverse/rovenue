import { describe, expect, it } from "vitest";
import {
  ROVENUE_EVENT_KEYS,
  isRovenueEventKey,
  WEBHOOK_API_VERSION,
  type RovenueEventKey,
} from "./integrations";

describe("RovenueEventKey", () => {
  it("includes all 20 canonical keys (v2, Wave-1 + 2026-09-03 paused/recovered/revoked)", () => {
    expect(ROVENUE_EVENT_KEYS).toEqual([
      "revenue.INITIAL",
      "revenue.TRIAL_CONVERSION",
      "revenue.RENEWAL",
      "revenue.CREDIT_PURCHASE",
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
