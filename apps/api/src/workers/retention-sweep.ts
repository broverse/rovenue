import { drizzle, type Db } from "@rovenue/db";
import {
  RETENTION_POLICIES,
  resolveRetentionWindowDays,
  type RetentionPolicy,
} from "@rovenue/shared/retention";
import { logger } from "../lib/logger";
import {
  retentionRowsReclaimedTotal,
  retentionSweepSkippedTotal,
} from "../lib/metrics";

// =============================================================
// Retention sweep (ROADMAP §9.2 Task 3)
// =============================================================
//
// Rovenue used to have three bespoke retention workers, each with its
// own hardcoded or env-driven window, none of which consulted the
// project's billing tier. This sweep is the registry-driven
// replacement: it walks every project × every policy in
// `RETENTION_POLICIES` (@rovenue/shared/retention) and, for each unit,
// resolves how many days of history that project keeps for that
// table, then reclaims whatever has aged out.
//
// This task implements ONLY the `DELETE_ROWS` strategy. A policy whose
// strategy is `DROP_PARTITION` or `CHECKPOINT_TRUNCATE` is skipped
// loudly (a counted skip, not a silent no-op) — Tasks 4 and 5 fill
// those in.
//
// --- Window resolution: three rules, because a project's billing
// tier is optional ---
//
// `tier`/`cycle` live on `billing_subscriptions`, not on `projects`,
// and billing is cloud-only (`HOST_MODE` defaults to "self"). On the
// development database that's 34 billing rows against 407 projects,
// so a tier-driven-only sweep would be inert for roughly nine projects
// in ten, and for every self-hosted deployment by construction.
//
//   1. A project WITH a billing subscription resolves normally via
//      `resolveRetentionWindowDays`: tier window, override clamped
//      down, policy floor applied.
//   2. A project WITHOUT one, but WITH an explicit override for that
//      table, uses the override clamped by the FLOOR ONLY. There is
//      no tier to clamp down to, and an operator who wrote the
//      override is the authority — this is how a self-hosted
//      deployment opts in.
//   3. A project with neither is skipped ("no-window"). It is NOT
//      defaulted to the free tier: free is the most aggressive rung on
//      the ladder (30 days, 7 for audit logs), so defaulting to it
//      would silently delete a self-hoster's audit history a week
//      after they installed. Retaining too much is recoverable;
//      deleting what nobody asked to delete is not.
//
// --- Per-item isolation ---
//
// The sweep iterates projects × policies; one project's failure must
// not abort the rest. Modeled on `leaderboard-scheduler.ts`'s
// `closeDueSeasons`, which exists because a sibling function lacking
// this isolation aborted every remaining item on one bad row: each
// (project, policy) unit runs in its own try/catch, increments
// `retentionSweepSkippedTotal` with a `reason` label on failure, and
// logs with `projectId` and `table`.

const log = logger.child("retention-sweep");

export const RETENTION_SWEEP_QUEUE_NAME = "rovenue-retention-sweep";

// Mirrors `deleteWebhookEventsOlderThan`'s batching shape
// (packages/db/src/drizzle/repositories/webhook-events.ts): bounded
// subselect, loop until a batch comes back partial, cap at
// `RETENTION_MAX_BATCHES` as a brake against a single long table lock.
export const RETENTION_DELETE_BATCH_SIZE = 10_000;
export const RETENTION_MAX_BATCHES = 1_000;

// retentionSweepSkippedTotal reason labels.
export const RETENTION_SKIP_REASON_NO_WINDOW = "no-window";
export const RETENTION_SKIP_REASON_STRATEGY_NOT_IMPLEMENTED =
  "strategy-not-implemented";
export const RETENTION_SKIP_REASON_ERROR = "error";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionSweepResult {
  rowsReclaimed: number;
  skipped: number;
}

type ProjectWithTier = Awaited<
  ReturnType<typeof drizzle.billingSubscriptionRepo.listProjectsWithTier>
>[number];

type BillingTierLimitsRow = typeof drizzle.schema.billingTierLimits.$inferSelect;

export interface RetentionDeps {
  db: Db;
  listProjectsWithTier: (db: Db) => Promise<ProjectWithTier[]>;
  findByTierAndCycle: (
    db: Db,
    tier: BillingTierLimitsRow["tier"],
    cycle: BillingTierLimitsRow["cycle"],
  ) => Promise<BillingTierLimitsRow | null>;
  listRetentionOverrides: (
    db: Db,
    projectId: string,
  ) => Promise<Map<string, number>>;
  deleteRetentionRows: (
    db: Db,
    table: string,
    timestampColumn: string,
    cutoff: Date,
    terminalStatuses: readonly string[] | undefined,
    batchSize: number,
    maxBatches: number,
  ) => Promise<number>;
}

export const defaultDeps: RetentionDeps = {
  db: drizzle.db,
  listProjectsWithTier: drizzle.billingSubscriptionRepo.listProjectsWithTier,
  findByTierAndCycle: drizzle.billingTierLimitsRepo.findByTierAndCycle,
  listRetentionOverrides: drizzle.retentionOverrideRepo.listRetentionOverrides,
  deleteRetentionRows: drizzle.retentionRowsRepo.deleteRetentionRowsOlderThan,
};

/**
 * Resolve how many days of history one project keeps for one policy,
 * applying the three rules documented in the module doc comment above.
 * Returns `null` when neither a tier nor an override exists — the
 * caller skips with `RETENTION_SKIP_REASON_NO_WINDOW`, never defaults.
 */
export function resolveProjectPolicyWindowDays(
  policy: RetentionPolicy,
  tierLimits: BillingTierLimitsRow | null,
  overrideDays: number | undefined,
): number | null {
  if (tierLimits) {
    // Rule 1: normal path. `resolveRetentionWindowDays` clamps the
    // override down against the tier and floors at the policy minimum.
    const tierDays = tierLimits[policy.tierLimitField];
    return resolveRetentionWindowDays({
      policy,
      tierDays,
      projectOverrideDays: overrideDays ?? null,
    });
  }

  if (overrideDays !== undefined) {
    // Rule 2: no tier to clamp down to. The operator who wrote the
    // override is the authority; only the policy's own floor still
    // applies.
    return Math.max(policy.minimumDays, overrideDays);
  }

  // Rule 3: neither a tier nor an override.
  return null;
}

/**
 * Sweep every project against every retention policy, reclaiming
 * whatever has aged past its resolved window. Only `DELETE_ROWS`
 * policies are acted on; `DROP_PARTITION`/`CHECKPOINT_TRUNCATE`
 * policies are counted as skipped until Tasks 4/5 land.
 */
export async function runRetentionSweep(
  now: Date,
  deps: RetentionDeps = defaultDeps,
): Promise<RetentionSweepResult> {
  const projectRows = await deps.listProjectsWithTier(deps.db);

  let rowsReclaimed = 0;
  let skipped = 0;

  for (const project of projectRows) {
    for (const policy of RETENTION_POLICIES) {
      try {
        const overrides = await deps.listRetentionOverrides(
          deps.db,
          project.projectId,
        );
        const overrideDays = overrides.get(policy.table);

        let tierLimits: BillingTierLimitsRow | null = null;
        if (project.tier && project.cycle) {
          tierLimits = await deps.findByTierAndCycle(
            deps.db,
            project.tier,
            project.cycle,
          );
        }

        const windowDays = resolveProjectPolicyWindowDays(
          policy,
          tierLimits,
          overrideDays,
        );
        if (windowDays === null) {
          skipped += 1;
          retentionSweepSkippedTotal.inc({
            reason: RETENTION_SKIP_REASON_NO_WINDOW,
            table: policy.table,
          });
          continue;
        }

        if (policy.strategy !== "DELETE_ROWS") {
          // Not silently ignored: a DROP_PARTITION/CHECKPOINT_TRUNCATE
          // policy is real, actionable work this task deliberately
          // does not implement. Tasks 4/5 fill these in.
          skipped += 1;
          retentionSweepSkippedTotal.inc({
            reason: RETENTION_SKIP_REASON_STRATEGY_NOT_IMPLEMENTED,
            table: policy.table,
          });
          continue;
        }

        const cutoff = new Date(now.getTime() - windowDays * MS_PER_DAY);
        const deleted = await deps.deleteRetentionRows(
          deps.db,
          policy.table,
          policy.timestampColumn,
          cutoff,
          policy.terminalStatuses,
          RETENTION_DELETE_BATCH_SIZE,
          RETENTION_MAX_BATCHES,
        );
        rowsReclaimed += deleted;
        retentionRowsReclaimedTotal.inc({ table: policy.table }, deleted);
      } catch (err) {
        // Per-item isolation: one project's bad row, missing tier
        // ladder entry, or transient DB error must not abort every
        // remaining (project, policy) unit in this sweep.
        skipped += 1;
        retentionSweepSkippedTotal.inc({
          reason: RETENTION_SKIP_REASON_ERROR,
          table: policy.table,
        });
        log.error("retention sweep unit failed", {
          projectId: project.projectId,
          table: policy.table,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const result: RetentionSweepResult = { rowsReclaimed, skipped };
  if (result.rowsReclaimed > 0 || result.skipped > 0) {
    log.info("retention sweep", { ...result });
  }
  return result;
}
