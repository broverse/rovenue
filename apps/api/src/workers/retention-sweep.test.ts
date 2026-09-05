import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETENTION_POLICIES } from "@rovenue/shared/retention";
import {
  RETENTION_DELETE_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  RETENTION_SKIP_REASON_ERROR,
  RETENTION_SKIP_REASON_NO_WINDOW,
  RETENTION_SKIP_REASON_STRATEGY_NOT_IMPLEMENTED,
  RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
  resolveProjectPolicyWindowDays,
  runRetentionSweep,
  type RetentionDeps,
} from "./retention-sweep";
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

  it("skips a policy whose strategy is not implemented yet", async () => {
    // credit_ledger is DROP_PARTITION. Its window still resolves fine
    // (tierDays=180 floored at 365 -> 365), but no delete is attempted:
    // a silent skip is the failure mode this test exists to prevent.
    await runRetentionSweep(NOW, deps as unknown as RetentionDeps);

    const creditLedgerCalls = deps.deleteRetentionRows.mock.calls.filter(
      (call) => call[1] === "credit_ledger",
    );
    expect(creditLedgerCalls).toHaveLength(0);
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_STRATEGY_NOT_IMPLEMENTED,
      table: "credit_ledger",
    });
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
    expect(retentionSweepSkippedTotal.inc).toHaveBeenCalledWith({
      reason: RETENTION_SKIP_REASON_NO_WINDOW,
      table: "webhook_events",
    });
    expect(result.rowsReclaimed).toBe(0);
    expect(result.skipped).toBe(RETENTION_POLICIES.length);
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
    // audit_logs is CHECKPOINT_TRUNCATE (Task 6, not this task), so the
    // window resolution itself — not a delete call — is what this test
    // pins.
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
