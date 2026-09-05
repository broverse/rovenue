// The OD-1 reversal (a DID_FAIL_TO_RENEW without the GRACE_PERIOD subtype
// maps to BILLING_ISSUE, not GRACE_PERIOD) used to be asserted here against
// `normalizeAppleStatus`, which no production path called. It is asserted
// against the live Apple ingestion path in
// `src/services/apple/apple-webhook.failed-renewal.test.ts`; the dead
// helper and this duplicate went on 2026-09-05 (Task 15).

import { describe, it, expect } from "vitest";
import {
  decideTransition,
  validateTransition,
} from "../src/services/subscription-state";

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
