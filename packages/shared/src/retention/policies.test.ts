import { describe, expect, it } from "vitest";
import {
  RETENTION_POLICIES,
  findRetentionPolicy,
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
  });

  it("finds a policy by table and returns undefined for an unknown one", () => {
    expect(findRetentionPolicy("audit_logs")?.strategy).toBe(
      "CHECKPOINT_TRUNCATE",
    );
    expect(findRetentionPolicy("no_such_table")).toBeUndefined();
  });
});
