import { describe, expect, it } from "vitest";
import {
  ACCESS_GRANTING_STATUSES,
  EXPIRY_SWEEP_STATUSES,
  LIVE_STATUSES,
  RECONCILABLE_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
} from "./subscription-status";

describe("subscription status semantics", () => {
  it("describes every status exactly once", () => {
    expect(Object.keys(SUBSCRIPTION_STATUS_SEMANTICS).sort()).toEqual(
      [...SUBSCRIPTION_STATUSES].sort(),
    );
  });

  it("derives the access-granting set", () => {
    expect([...ACCESS_GRANTING_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "TRIAL"],
    );
  });

  // BILLING_ISSUE is live: a held or retrying subscription is still a
  // subscription the dashboard must count (and show as at-risk), not a
  // churned one. Only an actual lapse retires it.
  it("derives the live set", () => {
    expect([...LIVE_STATUSES].sort()).toEqual(
      ["ACTIVE", "BILLING_ISSUE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the expiry sweep set", () => {
    expect([...EXPIRY_SWEEP_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  // BILLING_ISSUE is reconcilable but NOT sweepable — a held Play
  // subscription can still recover, so the store sweep must keep
  // re-polling it, while the expiry sweeper must not touch it (its
  // expiresDate is already past by the time the hold appears).
  it("derives the store-reconciliation set", () => {
    expect([...RECONCILABLE_STATUSES].sort()).toEqual(
      ["ACTIVE", "BILLING_ISSUE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the terminal set", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["REFUNDED", "REVOKED"]);
  });

  it("BILLING_ISSUE is involuntary, grants no access, and is not sweepable", () => {
    const s = SUBSCRIPTION_STATUS_SEMANTICS.BILLING_ISSUE;
    expect(s).toEqual({
      grantsAccess: false,
      isLive: true,
      isTerminal: false,
      sweepable: false,
      reconcilable: true,
      involuntary: true,
    });
  });

  it("keeps BILLING_ISSUE out of the expiry sweep but inside reconciliation", () => {
    expect(EXPIRY_SWEEP_STATUSES).not.toContain("BILLING_ISSUE");
    expect(RECONCILABLE_STATUSES).toContain("BILLING_ISSUE");
  });

  it("never marks a terminal status as sweepable or reconcilable", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(SUBSCRIPTION_STATUS_SEMANTICS[status].sweepable).toBe(false);
      expect(SUBSCRIPTION_STATUS_SEMANTICS[status].reconcilable).toBe(false);
    }
  });
});
