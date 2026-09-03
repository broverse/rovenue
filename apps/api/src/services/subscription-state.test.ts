// =============================================================
// subscription-state — BILLING_ISSUE transition edges
// =============================================================
//
// BILLING_ISSUE is an INVOLUNTARY suspension: the store has stopped
// covering a failed payment (Google account hold, Apple billing retry
// with no grace period configured, Stripe `unpaid`/`incomplete`). The
// edges below are the whole contract:
//
//   - entry from every access-granting status (a payment can fail from
//     TRIAL, ACTIVE or GRACE_PERIOD alike);
//   - exit to ACTIVE (the store recovered the payment), to EXPIRED (the
//     hold ran out), or to either terminal status;
//   - NO edge to PAUSED — PAUSED is the user's own choice, and letting a
//     dunning row slide into it would relabel involuntary churn as
//     voluntary in every rollup that reads `involuntary`;
//   - no edge INTO it from a terminal status, which stays absorbing.

import { describe, expect, it } from "vitest";
import { GOOGLE_SUBSCRIPTION_STATE } from "./google/google-types";
import {
  billingIssueStamp,
  normalizeAppleStatus,
  normalizeGoogleStatus,
  normalizeStripeStatus,
  validateTransition,
} from "./subscription-state";

describe("BILLING_ISSUE transitions", () => {
  it("allows entry into BILLING_ISSUE from every granting status", () => {
    expect(validateTransition("ACTIVE", "BILLING_ISSUE")).toBe(true);
    expect(validateTransition("TRIAL", "BILLING_ISSUE")).toBe(true);
    expect(validateTransition("GRACE_PERIOD", "BILLING_ISSUE")).toBe(true);
  });

  it("allows recovery and lapse out of BILLING_ISSUE, but not a voluntary pause", () => {
    expect(validateTransition("BILLING_ISSUE", "ACTIVE")).toBe(true);
    expect(validateTransition("BILLING_ISSUE", "EXPIRED")).toBe(true);
    expect(validateTransition("BILLING_ISSUE", "REFUNDED")).toBe(true);
    expect(validateTransition("BILLING_ISSUE", "REVOKED")).toBe(true);
    expect(validateTransition("BILLING_ISSUE", "PAUSED")).toBe(false);
  });

  it("keeps terminal states absorbing against BILLING_ISSUE", () => {
    expect(validateTransition("REFUNDED", "BILLING_ISSUE")).toBe(false);
    expect(validateTransition("REVOKED", "BILLING_ISSUE")).toBe(false);
  });

  // Re-delivery of the same store signal must not be refused: the
  // ingestion guard calls validateTransition for every write, including
  // an idempotent replay of the notification that created the row.
  it("permits an idempotent BILLING_ISSUE re-write", () => {
    expect(validateTransition("BILLING_ISSUE", "BILLING_ISSUE")).toBe(true);
  });
});

describe("billing issue mapping", () => {
  it("keeps Apple's configured grace period access-granting", () => {
    expect(normalizeAppleStatus("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toBe(
      "GRACE_PERIOD",
    );
  });

  it("routes Apple billing retry without grace to BILLING_ISSUE", () => {
    expect(normalizeAppleStatus("DID_FAIL_TO_RENEW", "BILLING_RETRY")).toBe(
      "BILLING_ISSUE",
    );
    expect(normalizeAppleStatus("DID_FAIL_TO_RENEW", undefined)).toBe(
      "BILLING_ISSUE",
    );
  });

  it("separates Google account hold from a voluntary pause", () => {
    expect(normalizeGoogleStatus(GOOGLE_SUBSCRIPTION_STATE.ON_HOLD)).toBe(
      "BILLING_ISSUE",
    );
    expect(normalizeGoogleStatus(GOOGLE_SUBSCRIPTION_STATE.PAUSED)).toBe(
      "PAUSED",
    );
  });

  it("separates Stripe's retrying and non-paying statuses", () => {
    expect(normalizeStripeStatus("past_due")).toBe("GRACE_PERIOD");
    expect(normalizeStripeStatus("unpaid")).toBe("BILLING_ISSUE");
    expect(normalizeStripeStatus("incomplete")).toBe("BILLING_ISSUE");
  });
});

describe("billingIssueStamp", () => {
  const now = new Date("2026-09-03T00:00:00Z");

  it("stamps on entry", () => {
    expect(billingIssueStamp("ACTIVE", "BILLING_ISSUE", now)).toEqual({
      billingIssueDetectedAt: now,
    });
  });

  it("does not reset the clock on a repeated signal", () => {
    expect(billingIssueStamp("BILLING_ISSUE", "BILLING_ISSUE", now)).toEqual(
      {},
    );
  });

  it("clears on recovery to a granting status", () => {
    expect(billingIssueStamp("BILLING_ISSUE", "ACTIVE", now)).toEqual({
      billingIssueDetectedAt: null,
    });
  });

  it("leaves the stamp alone on a lapse to EXPIRED", () => {
    expect(billingIssueStamp("BILLING_ISSUE", "EXPIRED", now)).toEqual({});
  });
});
