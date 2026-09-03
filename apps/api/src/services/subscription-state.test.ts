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
import { validateTransition } from "./subscription-state";

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
