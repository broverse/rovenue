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

  it("derives the live set", () => {
    expect([...LIVE_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the expiry sweep set", () => {
    expect([...EXPIRY_SWEEP_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the store-reconciliation set", () => {
    expect([...RECONCILABLE_STATUSES].sort()).toEqual(
      ["ACTIVE", "GRACE_PERIOD", "PAUSED", "TRIAL"],
    );
  });

  it("derives the terminal set", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["REFUNDED", "REVOKED"]);
  });

  it("never marks a terminal status as sweepable or reconcilable", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(SUBSCRIPTION_STATUS_SEMANTICS[status].sweepable).toBe(false);
      expect(SUBSCRIPTION_STATUS_SEMANTICS[status].reconcilable).toBe(false);
    }
  });
});
