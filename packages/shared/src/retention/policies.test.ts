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

  it("finds a policy by table and returns undefined for an unknown one", () => {
    expect(findRetentionPolicy("audit_logs")?.strategy).toBe(
      "CHECKPOINT_TRUNCATE",
    );
    expect(findRetentionPolicy("no_such_table")).toBeUndefined();
  });
});
