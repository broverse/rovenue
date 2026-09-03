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
  //
  // BILLING_ISSUE joined this set the moment it was declared (live,
  // involuntary, non-granting) — which is the intended behaviour the
  // derivation was written for, and exactly what a by-name list would
  // have missed.
  it("the metrics module's at-risk derivation matches GRACE_PERIOD, PAUSED and BILLING_ISSUE", () => {
    expect([...__subscriptionsConstants.AT_RISK_STATUSES].sort()).toEqual(
      ["BILLING_ISSUE", "GRACE_PERIOD", "PAUSED"].sort(),
    );
  });

  // The `case "grace"` SQL filter is built from AT_RISK_STATUSES, while
  // mapStatus labels each returned row. Those are two code paths over one
  // set: a status filtered INTO the grace tab but labelled something else
  // renders a tab whose contents contradict its own rows. Adding
  // BILLING_ISSUE to the derivation would have done precisely that, since
  // mapStatus listed the grace statuses by name and fell through to
  // "active".
  it("labels every at-risk status as the grace tab it is filtered into", () => {
    for (const status of __subscriptionsConstants.AT_RISK_STATUSES) {
      expect(
        __subscriptionsConstants.mapStatus({ status, autoRenewStatus: null }),
      ).toBe("grace");
    }
  });
});
