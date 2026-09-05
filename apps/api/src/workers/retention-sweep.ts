import { drizzle, type Db } from "@rovenue/db";
import {
  RETENTION_POLICIES,
  resolveRetentionWindowDays,
  type RetentionPolicy,
} from "@rovenue/shared/retention";
import { logger } from "../lib/logger";
import {
  retentionRowsReclaimedTotal,
  retentionSweepBatchCapReachedTotal,
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
// table, then reclaims whatever has aged out — scoped to THAT project
// alone (see `deleteRetentionRows` / packages/db's `retention-rows.ts`:
// a global, unscoped delete would mean one project's resolved window,
// however short, destroys every project's rows in that table).
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
//   1. A project WITH a billing subscription AND a matching
//      `billing_tier_limits` row resolves normally via
//      `resolveRetentionWindowDays`: tier window, override clamped
//      down, policy floor applied.
//   2. A project WITHOUT a billing subscription, but WITH an explicit
//      override for that table, uses the override clamped by the
//      FLOOR ONLY. There is no tier to clamp down to, and an operator
//      who wrote the override is the authority — this is how a
//      self-hosted deployment opts in.
//   3. A project with neither is skipped ("no-window"). It is NOT
//      defaulted to the free tier: free is the most aggressive rung on
//      the ladder (30 days, 7 for audit logs), so defaulting to it
//      would silently delete a self-hoster's audit history a week
//      after they installed. Retaining too much is recoverable;
//      deleting what nobody asked to delete is not.
//
// A fourth case sits outside all three rules: a project WITH a billing
// subscription whose (tier, cycle) has no row at all in
// `billing_tier_limits` (a reference-ladder integrity gap). That is
// NOT the same as "no tier" — falling through to rule 2/3 would
// silently drop a PAYING project's tier clamp — so it gets its own
// skip reason (`tier-limits-not-found`) and a warn log rather than
// being folded into "no-window".
//
// --- Per-item isolation ---
//
// The sweep iterates projects × policies; one project's failure must
// not abort the rest. Modeled on `leaderboard-scheduler.ts`'s
// `closeDueSeasons`, which exists because a sibling function lacking
// this isolation aborted every remaining item on one bad row. A
// project-level fetch (overrides, tier limits — both project facts,
// not policy facts, so both are fetched once per project rather than
// once per policy) is isolated at the project level; the per-policy
// window resolution + delete is isolated at the (project, policy)
// level, incrementing `retentionSweepSkippedTotal` with a `reason`
// label on failure and logging with `projectId` and `table`.

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
export const RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND =
  "tier-limits-not-found";
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

export interface DeleteRetentionRowsResult {
  deleted: number;
  hitBatchCap: boolean;
}

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
    projectId: string,
    cutoff: Date,
    terminalStatuses: readonly string[] | undefined,
    batchSize: number,
    maxBatches: number,
  ) => Promise<DeleteRetentionRowsResult>;
}

export const defaultDeps: RetentionDeps = {
  db: drizzle.db,
  listProjectsWithTier: drizzle.billingSubscriptionRepo.listProjectsWithTier,
  findByTierAndCycle: drizzle.billingTierLimitsRepo.findByTierAndCycle,
  listRetentionOverrides: drizzle.retentionOverrideRepo.listRetentionOverrides,
  deleteRetentionRows: drizzle.retentionRowsRepo.deleteRetentionRowsOlderThan,
};

type WindowSkipReason =
  | typeof RETENTION_SKIP_REASON_NO_WINDOW
  | typeof RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND;

export type WindowResolution =
  | { kind: "resolved"; days: number }
  | { kind: "skip"; reason: WindowSkipReason };

/**
 * Resolve how many days of history one project keeps for one policy,
 * applying the rules documented in the module doc comment above.
 */
export function resolveProjectPolicyWindowDays(
  policy: RetentionPolicy,
  hasTier: boolean,
  tierLimits: BillingTierLimitsRow | null,
  overrideDays: number | undefined,
): WindowResolution {
  if (hasTier && !tierLimits) {
    // The project names a (tier, cycle) pair but the reference ladder
    // has no matching row — a billing_tier_limits integrity gap, not
    // an ordinary no-tier project. Skip loudly rather than silently
    // treating a paying project's tier clamp as absent.
    return {
      kind: "skip",
      reason: RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
    };
  }

  if (tierLimits) {
    // Rule 1: normal path. `resolveRetentionWindowDays` clamps the
    // override down against the tier and floors at the policy minimum.
    const tierDays = tierLimits[policy.tierLimitField];
    const days = resolveRetentionWindowDays({
      policy,
      tierDays,
      projectOverrideDays: overrideDays ?? null,
    });
    return { kind: "resolved", days };
  }

  if (overrideDays !== undefined) {
    // Rule 2: no tier to clamp down to. The operator who wrote the
    // override is the authority; only the policy's own floor still
    // applies.
    return { kind: "resolved", days: Math.max(policy.minimumDays, overrideDays) };
  }

  // Rule 3: neither a tier nor an override.
  return { kind: "skip", reason: RETENTION_SKIP_REASON_NO_WINDOW };
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
    const hasTier = Boolean(project.tier && project.cycle);

    // Project-level facts, fetched once per project (not once per
    // policy — both are the same for every policy this project is
    // checked against). A failure here skips every policy for this
    // project but leaves the rest of the sweep untouched.
    let overrides: Map<string, number>;
    let tierLimits: BillingTierLimitsRow | null = null;
    try {
      overrides = await deps.listRetentionOverrides(
        deps.db,
        project.projectId,
      );
      if (hasTier) {
        tierLimits = await deps.findByTierAndCycle(
          deps.db,
          project.tier!,
          project.cycle!,
        );
      }
    } catch (err) {
      for (const policy of RETENTION_POLICIES) {
        skipped += 1;
        retentionSweepSkippedTotal.inc({
          reason: RETENTION_SKIP_REASON_ERROR,
          table: policy.table,
        });
      }
      log.error("retention sweep failed to load project facts", {
        projectId: project.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const policy of RETENTION_POLICIES) {
      try {
        const overrideDays = overrides.get(policy.table);

        const resolution = resolveProjectPolicyWindowDays(
          policy,
          hasTier,
          tierLimits,
          overrideDays,
        );
        if (resolution.kind === "skip") {
          skipped += 1;
          retentionSweepSkippedTotal.inc({
            reason: resolution.reason,
            table: policy.table,
          });
          if (resolution.reason === RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND) {
            log.warn(
              "billing_tier_limits has no row for this project's tier/cycle; skipping window resolution",
              {
                projectId: project.projectId,
                table: policy.table,
                tier: project.tier,
                cycle: project.cycle,
              },
            );
          }
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

        const cutoff = new Date(now.getTime() - resolution.days * MS_PER_DAY);
        const { deleted, hitBatchCap } = await deps.deleteRetentionRows(
          deps.db,
          policy.table,
          policy.timestampColumn,
          project.projectId,
          cutoff,
          policy.terminalStatuses,
          RETENTION_DELETE_BATCH_SIZE,
          RETENTION_MAX_BATCHES,
        );
        rowsReclaimed += deleted;
        retentionRowsReclaimedTotal.inc({ table: policy.table }, deleted);

        if (hitBatchCap) {
          retentionSweepBatchCapReachedTotal.inc({ table: policy.table });
          log.warn(
            "retention sweep hit its batch cap; rows past the cutoff may remain",
            {
              projectId: project.projectId,
              table: policy.table,
              deleted,
              maxBatches: RETENTION_MAX_BATCHES,
              batchSize: RETENTION_DELETE_BATCH_SIZE,
            },
          );
        }
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
