import { describe, expect, it } from "vitest";
import {
  ACCESS_GRANTING_STATUSES,
  TERMINAL_STATUSES,
} from "@rovenue/shared/subscription-status";
import { purchaseRepoTerminalStatuses } from "@rovenue/db";
import { allowedTransitions } from "./subscription-state";
import { __subscriptionsConstants } from "./metrics/subscriptions";

describe("status list agreement", () => {
  it("the state machine gives terminal statuses no outgoing edge but themselves", () => {
    for (const status of TERMINAL_STATUSES) {
      expect([...allowedTransitions(status)]).toEqual([status]);
    }
  });

  it("every access-granting status is reachable from ACTIVE or is ACTIVE", () => {
    const fromActive = allowedTransitions("ACTIVE");
    for (const status of ACCESS_GRANTING_STATUSES) {
      expect(fromActive.has(status)).toBe(true);
    }
  });

  // purchases.ts:24's TERMINAL_STATUSES is a DELIBERATE duplicate: a
  // data-layer guard that must keep refusing to resurrect a terminal row
  // even when the application layer is wrong, so it must not import the
  // shared list. This pins the two together without coupling them.
  it("the data-layer terminal guard matches the derived terminal set", () => {
    expect([...purchaseRepoTerminalStatuses()].sort()).toEqual(
      [...TERMINAL_STATUSES].sort(),
    );
  });

  // Pin for the metrics module's "grace"/at-risk scope: AT_RISK_STATUSES is
  // derived as `live AND (involuntary OR NOT grantsAccess)`, not listed by
  // name (see metrics/subscriptions.ts). This asserts today's derivation
  // still lands on exactly GRACE_PERIOD and PAUSED — the defect this guards
  // against is a derivation rule that silently changes membership (an
  // earlier proposed rule collapsed this to ["PAUSED"] because GRACE_PERIOD
  // grants access, dropping grace-period subscribers from the dashboard's
  // at-risk count).
  it("the metrics module's at-risk derivation matches GRACE_PERIOD and PAUSED", () => {
    expect([...__subscriptionsConstants.AT_RISK_STATUSES].sort()).toEqual(
      ["GRACE_PERIOD", "PAUSED"].sort(),
    );
  });
});
