import { describe, expect, it } from "vitest";
import {
  ROVENUE_EVENT_KEYS,
  isRovenueEventKey,
  type RovenueEventKey,
} from "./integrations";

describe("RovenueEventKey", () => {
  it("includes all 8 canonical keys", () => {
    expect(ROVENUE_EVENT_KEYS).toEqual([
      "revenue.INITIAL",
      "revenue.TRIAL_CONVERSION",
      "revenue.RENEWAL",
      "revenue.CREDIT_PURCHASE",
      "revenue.REFUND",
      "revenue.CANCELLATION",
      "subscription.trial.started",
      "subscriber.identified",
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

  it("rejects unknown strings", () => {
    expect(isRovenueEventKey("revenue.UNKNOWN")).toBe(false);
    expect(isRovenueEventKey("")).toBe(false);
  });
});
