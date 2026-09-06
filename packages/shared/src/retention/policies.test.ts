import { describe, expect, it } from "vitest";
import { IMPORT_FILE_RETENTION_DAYS } from "../import/constants";
import {
  RETENTION_POLICIES,
  RETENTION_SKIP_REASON_NO_WINDOW,
  findRetentionPolicy,
  resolveProjectPolicyWindowDays,
  resolveRetentionWindowDays,
  type RetentionPolicy,
} from "./policies";

const auditPolicy: RetentionPolicy = {
  table: "audit_logs",
  timestampColumn: "createdAt",
  strategy: "CHECKPOINT_TRUNCATE",
  tierLimitField: "auditLogDays",
  minimumDays: 30,
};

// A policy shaped like the real `webhook_events` / `copilot_messages`
// entries, WITH a defaultDays — used to test the fallback in isolation
// from the real registry (whose exact defaultDays value is separately
// pinned below).
const policyWithDefault: RetentionPolicy = {
  table: "test_table_with_default",
  timestampColumn: "createdAt",
  strategy: "DELETE_ROWS",
  tierLimitField: "retentionDays",
  minimumDays: 7,
  defaultDays: 90,
};

// The same shape, but with no defaultDays — the ordinary (pre-fix-round-1)
// case every other policy still has.
const policyWithoutDefault: RetentionPolicy = {
  table: "test_table_without_default",
  timestampColumn: "createdAt",
  strategy: "DELETE_ROWS",
  tierLimitField: "retentionDays",
  minimumDays: 7,
};

describe("resolveRetentionWindowDays", () => {
  it("uses the tier window when there is no override", () => {
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: null,
      }),
    ).toBe(365);
  });

  it("lets a project shorten its window", () => {
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: 90,
      }),
    ).toBe(90);
  });

  it("clamps an override that tries to exceed the tier", () => {
    // A longer window is a storage-cost and compliance decision the tier
    // already made. An override may only ever shorten.
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 180,
        projectOverrideDays: 3650,
      }),
    ).toBe(180);
  });

  it("clamps an override below the policy floor", () => {
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: 1,
      }),
    ).toBe(30);
  });

  it("raises a tier window that is itself below the floor", () => {
    // free tier's auditLogDays is 7, below the 30-day audit floor. The
    // floor wins: deleting a compliance record after a week is not a
    // retention policy anyone can defend.
    expect(
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 7,
        projectOverrideDays: null,
      }),
    ).toBe(30);
  });

  it("rejects a non-finite tier window", () => {
    expect(() =>
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: Number.NaN,
        projectOverrideDays: null,
      }),
    ).toThrow();
    expect(() =>
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: Number.POSITIVE_INFINITY,
        projectOverrideDays: null,
      }),
    ).toThrow();
  });

  it("rejects a non-finite project override", () => {
    expect(() =>
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      resolveRetentionWindowDays({
        policy: auditPolicy,
        tierDays: 365,
        projectOverrideDays: Number.NEGATIVE_INFINITY,
      }),
    ).toThrow();
  });
});

describe("RETENTION_POLICIES", () => {
  it("names each table exactly once", () => {
    const tables = RETENTION_POLICIES.map((p) => p.table);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it("gives every policy a positive floor", () => {
    for (const policy of RETENTION_POLICIES) {
      expect(policy.minimumDays).toBeGreaterThan(0);
    }
  });

  it("restricts the lifecycle tables to terminal statuses", () => {
    // outgoing_webhooks rows are still owed until they reach a terminal
    // state. A policy that expires them by age alone would delete
    // undelivered webhooks, so the registry must carry the restriction.
    const outgoing = findRetentionPolicy("outgoing_webhooks");
    expect(outgoing?.terminalStatuses?.length).toBeGreaterThan(0);
  });

  it("pins outgoing_webhooks' terminal set to exactly SENT/DEAD/DISMISSED", () => {
    // Equality alone would go stale silently if the set were reordered
    // without changing membership, so pin the exact array...
    expect(findRetentionPolicy("outgoing_webhooks")?.terminalStatuses).toEqual(
      ["SENT", "DEAD", "DISMISSED"],
    );
  });

  it("never treats a still-owed outgoing_webhooks status as terminal", () => {
    // ...and separately assert absence in the terms the bug would
    // violate: PENDING, DELIVERING and FAILED rows are still owed a
    // delivery attempt (apps/api/src/workers/webhook-delivery.ts polls
    // `status IN ('PENDING', 'FAILED')` forever). A single-line edit
    // that adds any of these back to the terminal array must fail here
    // even though `terminalStatuses.length > 0` would stay green.
    const terminal =
      findRetentionPolicy("outgoing_webhooks")?.terminalStatuses ?? [];
    expect(terminal).not.toContain("PENDING");
    expect(terminal).not.toContain("DELIVERING");
    expect(terminal).not.toContain("FAILED");
  });

  it("pins every policy's minimumDays floor", () => {
    expect(findRetentionPolicy("audit_logs")?.minimumDays).toBe(30);
    expect(findRetentionPolicy("credit_ledger")?.minimumDays).toBe(365);
    expect(findRetentionPolicy("revenue_events")?.minimumDays).toBe(365);
    expect(findRetentionPolicy("outgoing_webhooks")?.minimumDays).toBe(7);
    expect(findRetentionPolicy("webhook_events")?.minimumDays).toBe(7);
    expect(findRetentionPolicy("copilot_messages")?.minimumDays).toBe(7);
    expect(findRetentionPolicy("import_jobs")?.minimumDays).toBe(7);
  });

  it("keeps import_jobs' floor equal to IMPORT_FILE_RETENTION_DAYS, not a re-typed copy of it", () => {
    // Task 6: this table's floor is the exact number
    // `workers/import-retention.ts` used as an unconditional constant
    // before the registry existed. Importing the same constant (rather
    // than writing `7` a second time) is what makes that continuity a
    // compile-time fact instead of two numbers a future edit can drift
    // apart.
    expect(findRetentionPolicy("import_jobs")?.minimumDays).toBe(
      IMPORT_FILE_RETENTION_DAYS,
    );
  });

  it("marks import_jobs EXTERNAL_WORKER, never a strategy runRetentionSweep dispatches", () => {
    // import_jobs deletes object-storage files alongside its row and
    // tracks that with `filesDeletedAt` — a plain DELETE_ROWS pass over
    // it from the generic sweep would delete the ROW and silently
    // orphan its files in the bucket. EXTERNAL_WORKER exists so this
    // table's WINDOW still comes from the registry without the generic
    // sweep ever touching its rows.
    expect(findRetentionPolicy("import_jobs")?.strategy).toBe(
      "EXTERNAL_WORKER",
    );
  });

  it("pins every policy's timestampColumn", () => {
    expect(findRetentionPolicy("audit_logs")?.timestampColumn).toBe(
      "createdAt",
    );
    expect(findRetentionPolicy("credit_ledger")?.timestampColumn).toBe(
      "createdAt",
    );
    // revenue_events is the one that differs from its neighbours (it
    // ages on the economically-meaningful `eventDate`, not the row's
    // insert time) — pinned explicitly since that's exactly the kind
    // of detail a careless edit normalises away.
    expect(findRetentionPolicy("revenue_events")?.timestampColumn).toBe(
      "eventDate",
    );
    expect(findRetentionPolicy("outgoing_webhooks")?.timestampColumn).toBe(
      "createdAt",
    );
    expect(findRetentionPolicy("webhook_events")?.timestampColumn).toBe(
      "createdAt",
    );
    expect(findRetentionPolicy("copilot_messages")?.timestampColumn).toBe(
      "createdAt",
    );
    // import_jobs ages on when the job FINISHED, not when it was
    // created — a long-running job must never be swept mid-flight.
    expect(findRetentionPolicy("import_jobs")?.timestampColumn).toBe(
      "finishedAt",
    );
  });

  it("finds a policy by table and returns undefined for an unknown one", () => {
    expect(findRetentionPolicy("audit_logs")?.strategy).toBe(
      "CHECKPOINT_TRUNCATE",
    );
    expect(findRetentionPolicy("no_such_table")).toBeUndefined();
  });

  it("gives webhook_events and copilot_messages the 90-day defaultDays those tables retained unconditionally before this registry existed, and nothing else one", () => {
    // Fix round 1, Finding 1: these two tables were deleted at a fixed
    // 90 days for EVERY project by the bespoke workers this registry
    // replaced, tier or no tier. Every other policy must have NO
    // defaultDays — inventing one for a table that never had an
    // unconditional window (audit_logs, credit_ledger, revenue_events,
    // outgoing_webhooks, import_jobs) is the exact mistake this fix
    // exists to avoid making in the other direction.
    expect(findRetentionPolicy("webhook_events")?.defaultDays).toBe(90);
    expect(findRetentionPolicy("copilot_messages")?.defaultDays).toBe(90);

    const tablesWithNoDefault = RETENTION_POLICIES.filter(
      (p) => p.table !== "webhook_events" && p.table !== "copilot_messages",
    );
    for (const policy of tablesWithNoDefault) {
      expect(policy.defaultDays).toBeUndefined();
    }
  });
});

describe("resolveProjectPolicyWindowDays — defaultDays fallback (fix round 1, Finding 1)", () => {
  it("resolves a no-tier, no-override project to defaultDays when the policy has one", () => {
    const resolution = resolveProjectPolicyWindowDays(
      policyWithDefault,
      false,
      null,
      undefined,
    );
    expect(resolution).toEqual({ kind: "resolved", days: 90 });
  });

  it("still skips a no-tier, no-override project by name when the policy has NO defaultDays", () => {
    // Red-checked: removing `defaultDays` from copilot_messages's real
    // registry entry and re-running this suite fails the test above
    // (90 !== undefined) rather than this one — this one asserts the
    // OTHER branch stays intact for every policy that never had an
    // unconditional predecessor.
    const resolution = resolveProjectPolicyWindowDays(
      policyWithoutDefault,
      false,
      null,
      undefined,
    );
    expect(resolution).toEqual({
      kind: "skip",
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
    });
  });

  it("lets an explicit override beat defaultDays, not just a tier", () => {
    // Rule 2 (no tier, override present) is checked before the
    // defaultDays fallback, so a project that bothered to override
    // still gets what it asked for, floored — never silently
    // overridden by the table's carried-forward default.
    const resolution = resolveProjectPolicyWindowDays(
      policyWithDefault,
      false,
      null,
      30,
    );
    expect(resolution).toEqual({ kind: "resolved", days: 30 });
  });

  it("floors defaultDays exactly like every other resolved branch", () => {
    const lowFloorPolicy: RetentionPolicy = {
      ...policyWithDefault,
      minimumDays: 120,
      defaultDays: 90,
    };
    const resolution = resolveProjectPolicyWindowDays(
      lowFloorPolicy,
      false,
      null,
      undefined,
    );
    expect(resolution).toEqual({ kind: "resolved", days: 120 });
  });
});
