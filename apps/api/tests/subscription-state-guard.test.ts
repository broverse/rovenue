import { describe, it, expect } from "vitest";
import {
  decideTransition,
  normalizeAppleStatus,
  validateTransition,
} from "../src/services/subscription-state";
import {
  APPLE_NOTIFICATION_TYPE,
  APPLE_NOTIFICATION_SUBTYPE,
} from "../src/services/apple/apple-types";

describe("normalizeAppleStatus DID_FAIL_TO_RENEW (OD-1)", () => {
  // Task 4 (2026-09-04): without the GRACE_PERIOD subtype, Apple has
  // already withdrawn access on its side — reporting GRACE_PERIOD here
  // (the prior expectation) granted entitlement Apple itself had revoked.
  // It now maps to BILLING_ISSUE.
  it("maps a non-grace failed renewal to BILLING_ISSUE, not ACTIVE or GRACE_PERIOD", () => {
    expect(
      normalizeAppleStatus(APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW, undefined),
    ).toBe("BILLING_ISSUE");
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

describe("decideTransition", () => {
  it("allows first insert (null from)", () => {
    expect(decideTransition(null, "ACTIVE")).toEqual({
      apply: true,
      from: null,
      to: "ACTIVE",
    });
  });
  it("rejects REFUNDED -> ACTIVE", () => {
    expect(decideTransition("REFUNDED", "ACTIVE").apply).toBe(false);
  });
  it("allows ACTIVE -> GRACE_PERIOD", () => {
    expect(decideTransition("ACTIVE", "GRACE_PERIOD").apply).toBe(true);
  });
});
