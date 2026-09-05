import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_POLICIES } from "@rovenue/shared/retention";
import {
  RETENTION_DELETE_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  RETENTION_SKIP_REASON_ERROR,
  RETENTION_SKIP_REASON_NO_WINDOW,
  RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
  isPartitionDroppable,
  parsePartitionBoundExpr,
  resolveProjectPolicyWindowDays,
  runRetentionSweep,
  type RetentionDeps,
} from "./retention-sweep";
import {
  AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED,
  type CheckpointTruncateOutcome,
} from "../services/audit-retention/checkpoint";
import {
  retentionRowsReclaimedTotal,
  retentionSweepBatchCapReachedTotal,
  retentionSweepSkippedTotal,
} from "../lib/metrics";

const NOW = new Date("2026-09-05T00:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const auditLogsPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "audit_logs",
)!;
const creditLedgerPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "credit_ledger",
)!;
const outgoingWebhooksPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "outgoing_webhooks",
)!;
const webhookEventsPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "webhook_events",
)!;

function tierLimits(overrides: Record<string, unknown> = {}) {
  return {
    tier: "indie",
    cycle: "monthly",
    priceUsdCents: 4900,
    stripePriceId: "price_indie_monthly",
    mtrMin: "0",
    mtrMax: null,
    eventsLimit: null,
    sqlLimit: null,
    retentionDays: 180,
    auditLogDays: 30,
    assetStorageBytesLimit: null,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "prj_1",
    tier: "indie" as const,
    cycle: "monthly" as const,
    ...overrides,
  };
}

let deps: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  deps = {
    db: {} as never,
    listProjectsWithTier: vi.fn(async () => [project()]),
    findByTierAndCycle: vi.fn(async () => tierLimits()),
    listRetentionOverrides: vi.fn(async () => new Map<string, number>()),
    deleteRetentionRows: vi.fn(async () => ({ deleted: 0, hitBatchCap: false })),
    dropTablePartitionsOlderThan: vi.fn(async () => ({
      partitionsDropped: [],
      rowsDropped: 0,
    })),
    checkpointAndTruncate: vi.fn(
      async (): Promise<CheckpointTruncateOutcome> => ({
        kind: "checkpointed",
        deleted: 0,
        checkpointId: "cp_1",
        bundleKey: "audit-checkpoints/prj_1/cp_1.json",
        lastDeletedRowId: "al_1",
        lastDeletedRowHash: null,
        truncated: false,
      }),
    ),
  };
  vi.spyOn(retentionSweepSkippedTotal, "inc");
  vi.spyOn(retentionRowsReclaimedTotal, "inc");
  vi.spyOn(retentionSweepBatchCapReachedTotal, "inc");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runRetentionSweep", () => {
  it("resolves the window from the project's tier and its override", async () => {
    // webhook_events: tierDays=180 (retentionDays), override=30 -> clamped
    // down to 30, then floored at minimumDays=7 -> stays 30. The cutoff
    // handed to the delete must reflect that 30, not the 180 tier window
    // and not a hardcoded constant.
    deps.listRetentionOverrides.mockResolvedValue(
      new Map([["webhook_events", 30]]),
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    const expectedCutoff = new Date(NOW.getTime() - 30 * MS_PER_DAY);
    expect(deps.deleteRetentionRows).toHaveBeenCalledWith(
      deps.db,
      "webhook_events",
      webhookEventsPolicy.timestampColumn,
      "prj_1",
      expectedCutoff,
      webhookEventsPolicy.terminalStatuses,
      RETENTION_DELETE_BATCH_SIZE,
      RETENTION_MAX_BATCHES,
    );
  });

  it("drives CHECKPOINT_TRUNCATE through checkpointAndTruncate and DROP_PARTITION through dropTablePartitionsOlderThan, never deleteRetentionRows for either", async () => {
    // audit_logs is CHECKPOINT_TRUNCATE (Task 5, this task): its
    // window resolves fine (tierDays=30 from tier limits) so it must
    // be dispatched to the dedicated checkpointAndTruncate dependency
    // — a stray deleteRetentionRows call here would be silently
    // truncating the hash chain with no proof bundle ever exported.
    // credit_ledger is DROP_PARTITION: its window resolves fine
    // (tierDays=180 floored at 365 -> 365) and the lone project's
    // requirement is fully resolved, so the drop goes ahead via the
    // dedicated helper — a silent no-op OR a stray DELETE_ROWS call
    // are both failure modes this test exists to catch.
    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    const creditLedgerDeleteCalls = deps.deleteRetentionRows.mock.calls.filter(
      (call) => call[1] === "credit_ledger",
    );
    expect(creditLedgerDeleteCalls).toHaveLength(0);
    const auditLogsDeleteCalls = deps.deleteRetentionRows.mock.calls.filter(
      (call) => call[1] === "audit_logs",
    );
    expect(auditLogsDeleteCalls).toHaveLength(0);

    const expectedAuditCutoff = new Date(NOW.getTime() - 30 * MS_PER_DAY);
    expect(deps.checkpointAndTruncate).toHaveBeenCalledWith(
      deps.db,
      "prj_1",
      expectedAuditCutoff,
    );

    const expectedCutoff = new Date(NOW.getTime() - 365 * MS_PER_DAY);
    expect(deps.dropTablePartitionsOlderThan).toHaveBeenCalledWith(
      deps.db,
      "credit_ledger",
      expectedCutoff,
      new Map([["prj_1", 365]]),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("forwards a checkpointAndTruncate skip reason to the skipped metric and reclaims nothing", async () => {
    // storage-not-configured is CHECKPOINT_TRUNCATE's own fail-closed
    // skip reason (services/audit-retention/checkpoint.ts) — the sweep
    // must forward it verbatim, never collapse it into a generic
    // reason or (worse) treat it as rows reclaimed.
    deps.checkpointAndTruncate.mockResolvedValue({
      kind: "skipped",
      reason: AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED,
    });

    const result = await runRetentionSweep(
      NOW,
      deps as unknown as RetentionDeps,
    );

    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: AUDIT_CHECKPOINT_SKIP_REASON_STORAGE_NOT_CONFIGURED,
      table: "audit_logs",
    });
    expect(retentionRowsReclaimedTotal.inc).not.toHaveBeenCalledWith(
      { table: "audit_logs" },
      expect.anything(),
    );
    expect(result.rowsReclaimed).toBe(0);
  });

  it("counts a checkpointAndTruncate deletion as rows reclaimed", async () => {
    deps.checkpointAndTruncate.mockResolvedValue({
      kind: "checkpointed",
      deleted: 42,
      checkpointId: "cp_1",
      bundleKey: "audit-checkpoints/prj_1/cp_1.json",
      lastDeletedRowId: "al_1",
      lastDeletedRowHash: "deadbeef",
      truncated: false,
    });

    const result = await runRetentionSweep(
      NOW,
      deps as unknown as RetentionDeps,
    );

    expect(retentionRowsReclaimedTotal.inc).toHaveBeenCalledWith(
      { table: "audit_logs" },
      42,
    );
    expect(result.rowsReclaimed).toBeGreaterThanOrEqual(42);
  });

  it("blocks a DROP_PARTITION drop when even one project's window is unresolved", async () => {
    // A partition is shared by every project. Project 1 resolves a
    // window via its tier; project 2 has neither a tier nor an
    // override. Dropping using only project 1's window would destroy
    // project 2's rows the instant they land in the same physical
    // partition, so project 2's unresolved window must block the drop
    // entirely rather than being silently ignored.
    deps.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "prj_1" }),
      project({ projectId: "prj_2", tier: null, cycle: null }),
    ]);

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    expect(deps.dropTablePartitionsOlderThan).not.toHaveBeenCalled();
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
      table: "credit_ledger",
    });
  });

  it("uses the longest resolved window across every project, not merely the last one considered", async () => {
    // Project 1 (no tier, rule 2) has the LONGEST requirement — 900
    // days, unclamped by any tier ceiling — and is listed FIRST, not
    // last: a "last project wins" bug would pass this test if the
    // longest window happened to be the one processed last, so the
    // fixture deliberately puts it first. Project 2 floors at the
    // ordinary 365.
    deps.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "prj_1", tier: null, cycle: null }),
      project({ projectId: "prj_2" }),
    ]);
    deps.listRetentionOverrides.mockImplementation(
      async (_db: unknown, projectId: string) =>
        projectId === "prj_1"
          ? new Map([["credit_ledger", 900]])
          : new Map<string, number>(),
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    const expectedCutoff = new Date(NOW.getTime() - 900 * MS_PER_DAY);
    expect(deps.dropTablePartitionsOlderThan).toHaveBeenCalledWith(
      deps.db,
      "credit_ledger",
      expectedCutoff,
      new Map([
        ["prj_1", 900],
        ["prj_2", 365],
      ]),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("blocks a DROP_PARTITION drop when one project's fact-fetch errors, not just an ordinary no-window skip", async () => {
    // Three projects, all WITH a tier, so credit_ledger would otherwise
    // resolve normally for every one of them (unlike the DELETE_ROWS
    // "continues to the next project when one project throws" test,
    // whose projects have no tier and no override at all — that
    // fixture would leave the DROP_PARTITION aggregate blocked by the
    // ordinary no-window skip regardless of the throw, proving nothing
    // about the ERROR path specifically). The middle project's
    // overrides lookup rejects — a transient failure, not "this
    // project has no configured window" — and the fleet-level skip
    // this produces must carry the ERROR reason, never fall back to
    // NO_WINDOW just because that happens to be the more common cause.
    deps.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "prj_1" }),
      project({ projectId: "prj_2" }),
      project({ projectId: "prj_3" }),
    ]);
    let call = 0;
    deps.listRetentionOverrides.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("boom");
      return new Map<string, number>();
    });

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    expect(deps.dropTablePartitionsOlderThan).not.toHaveBeenCalled();
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_ERROR,
      table: "credit_ledger",
    });
    expect(retentionSweepSkippedTotal.inc).not.toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
      table: "credit_ledger",
    });
  });

  it("does not drop a partition when no project in the fleet resolved any window for it", async () => {
    deps.listProjectsWithTier.mockResolvedValue([]);

    const result = await runRetentionSweep(
      NOW,
      deps as unknown as RetentionDeps,
    );

    expect(deps.dropTablePartitionsOlderThan).not.toHaveBeenCalled();
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
      table: "credit_ledger",
    });
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
      table: "revenue_events",
    });
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("continues to the next project when one project throws", async () => {
    // Three projects, none with a billing tier, each with an override
    // ONLY for webhook_events (so exactly one DELETE_ROWS call happens
    // per project — the other DELETE_ROWS tables have no window and
    // are skipped, keeping the call sequence one-per-project). The
    // middle project's delete rejects.
    deps.listProjectsWithTier.mockResolvedValue([
      project({ projectId: "prj_1", tier: null, cycle: null }),
      project({ projectId: "prj_2", tier: null, cycle: null }),
      project({ projectId: "prj_3", tier: null, cycle: null }),
    ]);
    deps.listRetentionOverrides.mockResolvedValue(
      new Map([["webhook_events", 14]]),
    );

    let call = 0;
    deps.deleteRetentionRows.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("boom");
      return { deleted: 1, hitBatchCap: false };
    });

    await expect(
      runRetentionSweep(NOW, deps as unknown as RetentionDeps),
    ).resolves.not.toThrow();

    // The assertion that actually proves isolation: a sweep that
    // stopped after project 2's failure would never reach project 3,
    // and this call count would be 2, not 3.
    expect(deps.deleteRetentionRows).toHaveBeenCalledTimes(3);
    expect(deps.findByTierAndCycle).not.toHaveBeenCalled();
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_ERROR,
      table: "webhook_events",
    });
  });

  it("stops at the batch cap rather than looping forever", async () => {
    // The batching loop itself lives in the DELETE_ROWS repository
    // function; the sweep's job is to hand it the named caps rather
    // than an unbounded or ad-hoc value. Assert every DELETE_ROWS call
    // was wired with RETENTION_DELETE_BATCH_SIZE / RETENTION_MAX_BATCHES.
    deps.listRetentionOverrides.mockResolvedValue(
      new Map([["webhook_events", 30]]),
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    const webhookEventsCall = deps.deleteRetentionRows.mock.calls.find(
      (call) => call[1] === "webhook_events",
    );
    expect(webhookEventsCall).toBeDefined();
    expect(webhookEventsCall![6]).toBe(RETENTION_DELETE_BATCH_SIZE);
    expect(webhookEventsCall![7]).toBe(RETENTION_MAX_BATCHES);
  });

  it("logs and counts when a DELETE_ROWS unit hits the batch cap", async () => {
    // The batching loop lives in the repository function; the sweep's
    // job is to surface `hitBatchCap` rather than swallow it. Only
    // webhook_events reports the cap here — the assertion must fail if
    // the sweep attributes it to the wrong table or fires it for every
    // DELETE_ROWS call regardless of what the dependency returned.
    deps.deleteRetentionRows.mockImplementation(
      async (_db: unknown, table: string) => {
        if (table === "webhook_events") {
          return { deleted: RETENTION_DELETE_BATCH_SIZE, hitBatchCap: true };
        }
        return { deleted: 0, hitBatchCap: false };
      },
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    expect(retentionSweepBatchCapReachedTotal.inc).toHaveBeenCalledWith({
      table: "webhook_events",
    });
    expect(retentionSweepBatchCapReachedTotal.inc).not.toHaveBeenCalledWith({
      table: "outgoing_webhooks",
    });
    expect(retentionSweepBatchCapReachedTotal.inc).not.toHaveBeenCalledWith({
      table: "copilot_messages",
    });
  });

  it("only expires terminal rows for a policy with terminalStatuses", async () => {
    // outgoing_webhooks carries terminalStatuses. Red-check: drop the
    // status restriction (pass `undefined` instead of
    // policy.terminalStatuses) and this must fail — without it, an
    // old-but-undelivered webhook is destroyed silently.
    deps.listRetentionOverrides.mockResolvedValue(
      new Map([["outgoing_webhooks", 30]]),
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    const outgoingCall = deps.deleteRetentionRows.mock.calls.find(
      (call) => call[1] === "outgoing_webhooks",
    );
    expect(outgoingCall).toBeDefined();
    expect(outgoingCall![5]).toBe(outgoingWebhooksPolicy.terminalStatuses);
    expect(outgoingCall![5]).toEqual(["SENT", "DEAD", "DISMISSED"]);
  });

  it("uses the override alone when a project has no billing tier", async () => {
    // The self-hosted case, and the majority case on real data: no
    // billing_subscriptions row at all. The override (30, well above
    // the 7-day operational floor) drives the cutoff directly, never
    // clamped against a tier that does not exist.
    deps.listProjectsWithTier.mockResolvedValue([
      project({ tier: null, cycle: null }),
    ]);
    deps.listRetentionOverrides.mockResolvedValue(
      new Map([["webhook_events", 30]]),
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    expect(deps.findByTierAndCycle).not.toHaveBeenCalled();
    const expectedCutoff = new Date(NOW.getTime() - 30 * MS_PER_DAY);
    expect(deps.deleteRetentionRows).toHaveBeenCalledWith(
      deps.db,
      "webhook_events",
      webhookEventsPolicy.timestampColumn,
      "prj_1",
      expectedCutoff,
      webhookEventsPolicy.terminalStatuses,
      RETENTION_DELETE_BATCH_SIZE,
      RETENTION_MAX_BATCHES,
    );
  });

  it("skips a project with neither a tier nor an override", async () => {
    // Falling back to the free tier here would delete a self-hoster's
    // audit history seven days after they installed.
    deps.listProjectsWithTier.mockResolvedValue([
      project({ tier: null, cycle: null }),
    ]);
    deps.listRetentionOverrides.mockResolvedValue(new Map());

    const result = await runRetentionSweep(
      NOW,
      deps as unknown as RetentionDeps,
    );

    expect(deps.deleteRetentionRows).not.toHaveBeenCalled();
    expect(deps.dropTablePartitionsOlderThan).not.toHaveBeenCalled();
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
      table: "webhook_events",
    });
    expect(result.rowsReclaimed).toBe(0);
    // One skip per (project, policy) unit, PLUS one more per
    // DROP_PARTITION policy (credit_ledger, revenue_events): this
    // project's unresolved window blocks their fleet-wide drop
    // decision too, which is a second, distinct skip event on top of
    // its own per-project "no-window" skip.
    const dropPartitionPolicyCount = RETENTION_POLICIES.filter(
      (p) => p.strategy === "DROP_PARTITION",
    ).length;
    expect(result.skipped).toBe(
      RETENTION_POLICIES.length + dropPartitionPolicyCount,
    );
  });

  it("treats a missing billing_tier_limits row for a project WITH a tier as its own skip reason, never a silent fall-through to the override-only rule", async () => {
    // The project genuinely has a paid tier ("indie"/"monthly"), but the
    // reference ladder has no matching row for it. An override is ALSO
    // present here specifically to prove the sweep does not fall
    // through to the override-only rule (which lacks the tier's upper
    // clamp) — it must skip outright instead.
    deps.findByTierAndCycle.mockResolvedValue(null);
    deps.listRetentionOverrides.mockResolvedValue(
      new Map([["webhook_events", 30]]),
    );

    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    expect(deps.deleteRetentionRows).not.toHaveBeenCalled();
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
      table: "webhook_events",
    });
  });

  it("fetches project-level facts (overrides, tier limits) once per project, not once per policy", async () => {
    // RETENTION_POLICIES has 6 entries; a per-policy fetch would call
    // each of these 6 times for this single project.
    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    expect(deps.listRetentionOverrides).toHaveBeenCalledTimes(1);
    expect(deps.findByTierAndCycle).toHaveBeenCalledTimes(1);
  });

  it("never lets a no-tier override fall below the policy floor", () => {
    // An override of 1 day on audit_logs still resolves to the 30-day
    // floor. Without a tier there is nothing else holding the line.
    // Window resolution is independent of strategy dispatch (see
    // resolveProjectPolicyWindowDays), so the window resolution itself
    // — not a checkpointAndTruncate call — is what this test pins.
    const resolution = resolveProjectPolicyWindowDays(
      auditLogsPolicy,
      false,
      null,
      1,
    );
    expect(resolution).toEqual({ kind: "resolved", days: 30 });
  });

  it("resolves a DROP_PARTITION policy's window normally before skipping on strategy", () => {
    // Sanity check that window resolution and strategy dispatch are
    // independent: a project WITH a tier resolves credit_ledger's
    // window via the normal tier+floor rule even though the strategy
    // is not implemented here.
    const resolution = resolveProjectPolicyWindowDays(
      creditLedgerPolicy,
      true,
      tierLimits({ retentionDays: 180 }) as never,
      undefined,
    );
    expect(resolution).toEqual({ kind: "resolved", days: 365 }); // floored at CREDIT_LEDGER_MINIMUM_DAYS
  });

  it("resolveProjectPolicyWindowDays: a tier with no matching ladder row skips even with an override present", () => {
    const resolution = resolveProjectPolicyWindowDays(
      webhookEventsPolicy,
      true,
      null,
      30,
    );
    expect(resolution).toEqual({
      kind: "skip",
      reason: RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
    });
  });
});

describe("parsePartitionBoundExpr", () => {
  it("parses a literal FROM/TO bound exactly as pg_get_expr renders it", () => {
    // Format verified directly against this repo's Postgres.
    const parsed = parsePartitionBoundExpr(
      "credit_ledger_2024_03",
      "FOR VALUES FROM ('2024-03-01 00:00:00+00') TO ('2024-04-01 00:00:00+00')",
    );
    expect(parsed).toEqual({
      name: "credit_ledger_2024_03",
      lowerBound: new Date("2024-03-01T00:00:00.000Z"),
      upperBound: new Date("2024-04-01T00:00:00.000Z"),
    });
  });

  it("returns null for a DEFAULT partition", () => {
    // credit_ledger and revenue_events have no default partition today,
    // but this must never be treated as droppable if one is ever added.
    expect(
      parsePartitionBoundExpr("credit_ledger_default", "DEFAULT"),
    ).toBeNull();
  });

  it("treats an unbounded MAXVALUE upper bound as null, never a fixed Date", () => {
    const parsed = parsePartitionBoundExpr(
      "x",
      "FOR VALUES FROM ('2024-01-01 00:00:00+00') TO (MAXVALUE)",
    );
    expect(parsed?.upperBound).toBeNull();
  });

  it("returns null for an unrecognized bound expression rather than guessing", () => {
    expect(parsePartitionBoundExpr("x", "some unexpected text")).toBeNull();
  });
});

describe("isPartitionDroppable", () => {
  const cutoff = new Date("2024-06-01T00:00:00.000Z");

  it("is droppable when the whole partition predates the cutoff", () => {
    expect(
      isPartitionDroppable(
        { upperBound: new Date("2024-05-01T00:00:00.000Z") },
        cutoff,
      ),
    ).toBe(true);
  });

  it("is droppable when the upper bound lands exactly on the cutoff", () => {
    // Inclusive on purpose: the partition's range is [lower, upper), so
    // an upper bound equal to the cutoff means every row in it is
    // strictly before the cutoff.
    expect(isPartitionDroppable({ upperBound: cutoff }, cutoff)).toBe(true);
  });

  it("is NOT droppable when the cutoff falls inside the partition's range", () => {
    // The single most important assertion in this module: red-checked
    // by inverting the comparison to `>=` (which would make an
    // in-window partition report as droppable) and confirming this
    // test fails.
    expect(
      isPartitionDroppable(
        { upperBound: new Date("2024-07-01T00:00:00.000Z") },
        cutoff,
      ),
    ).toBe(false);
  });

  it("is never droppable with no fixed upper bound", () => {
    expect(isPartitionDroppable({ upperBound: null }, cutoff)).toBe(false);
  });
});
