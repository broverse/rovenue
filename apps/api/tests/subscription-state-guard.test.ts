import { describe, it, expect } from "vitest";
import {
  normalizeAppleStatus,
  validateTransition,
} from "../src/services/subscription-state";
import {
  APPLE_NOTIFICATION_TYPE,
  APPLE_NOTIFICATION_SUBTYPE,
} from "../src/services/apple/apple-types";

describe("normalizeAppleStatus DID_FAIL_TO_RENEW (OD-1)", () => {
  it("maps a non-grace failed renewal to GRACE_PERIOD, not ACTIVE", () => {
    expect(
      normalizeAppleStatus(APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW, undefined),
    ).toBe("GRACE_PERIOD");
  });
  it("still maps the grace subtype to GRACE_PERIOD", () => {
    expect(
      normalizeAppleStatus(
        APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW,
        APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD,
      ),
    ).toBe("GRACE_PERIOD");
  });
});

describe("validateTransition terminal states", () => {
  it("rejects REFUNDED -> ACTIVE", () => {
    expect(validateTransition("REFUNDED", "ACTIVE")).toBe(false);
  });
  it("allows EXPIRED -> ACTIVE (resubscribe)", () => {
    expect(validateTransition("EXPIRED", "ACTIVE")).toBe(true);
  });
});
