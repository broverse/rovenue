import { init } from "@paralleldrive/cuid2";
import { and, asc, count, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  experiments,
  type Experiment,
} from "../schema";
import { experimentStatus, experimentType } from "../enums";

type DbOrTx = Db;

// Experiment keys are backend-assigned and immutable. They are opaque
// `exp_<8-char cuid2>` identifiers — the SDK looks experiments up by this
// key, so it must never change once issued. Uniqueness is enforced by the
// (projectId, key) index; callers retry on a 23505 collision.
const shortExperimentId = init({ length: 8 });

export function generateExperimentKey(): string {
  return `exp_${shortExperimentId()}`;
}
type ExperimentStatus = (typeof experimentStatus.enumValues)[number];
type ExperimentType = (typeof experimentType.enumValues)[number];

export async function countExperiments(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(experiments)
    .where(eq(experiments.projectId, projectId));
  return Number(rows[0]?.total ?? 0);
}

// =============================================================
// Experiment reads — Drizzle repository
// =============================================================
//
// Mirrors the findMany calls in apps/api/src/services/
// experiment-engine.ts. Only running experiments feed the SDK
// bundle; the dashboard's list endpoint pulls every experiment
// and applies status + type filters client-side.

export async function findRunningExperimentsByProject(
  db: Db,
  projectId: string,
): Promise<Experiment[]> {
  // Deterministic order (oldest first) so the engine's mutual-exclusion
  // arbitration is stable: when a subscriber qualifies for several
  // experiments sharing a mutualExclusionGroup, the earliest-created one
  // always claims them. Without an explicit ORDER BY the winner would
  // depend on Postgres' physical row order and could differ across
  // cache rebuilds. `id` is the tiebreaker for same-timestamp rows.
  return db
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.projectId, projectId),
        eq(experiments.status, "RUNNING"),
      ),
    )
    .orderBy(asc(experiments.createdAt), asc(experiments.id));
}

export interface ExperimentFilters {
  projectId: string;
  status?: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  type?: "FLAG" | "OFFERING" | "PAYWALL" | "ELEMENT";
}

export async function findExperimentsByProject(
  db: Db,
  filters: ExperimentFilters,
): Promise<Experiment[]> {
  const clauses = [eq(experiments.projectId, filters.projectId)];
  if (filters.status) clauses.push(eq(experiments.status, filters.status));
  if (filters.type) clauses.push(eq(experiments.type, filters.type));
  return db.select().from(experiments).where(and(...clauses));
}

export async function findExperimentById(
  db: Db,
  id: string,
): Promise<Experiment | null> {
  const rows = await db
    .select()
    .from(experiments)
    .where(eq(experiments.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Project-scoped lookup. Returns the experiment only when it belongs to
 * the given project — used by SDK public-key endpoints so a caller can't
 * reference another tenant's experiment id. Returns null on no match or
 * cross-project id.
 */
export async function findByIdInProject(
  db: Db,
  id: string,
  projectId: string,
): Promise<Experiment | null> {
  const rows = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.id, id), eq(experiments.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Project-scoped lookup by the backend-assigned `key`. Used as the
 * SELECT-precheck before inserting a new experiment: a caller running
 * inside a transaction can't retry after a unique-violation (the
 * violation aborts the tx), so it checks for a collision first and
 * only inserts once it has a key it believes is free. The
 * (projectId, key) unique index remains the backstop for the
 * astronomically-unlikely race between the precheck and the insert.
 */
export async function findExperimentByKey(
  db: Db,
  projectId: string,
  key: string,
): Promise<Pick<Experiment, "id"> | null> {
  const rows = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(and(eq(experiments.projectId, projectId), eq(experiments.key, key)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findFirstExperimentByAudience(
  db: Db,
  audienceId: string,
): Promise<Pick<Experiment, "id"> | null> {
  const rows = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(eq(experiments.audienceId, audienceId))
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Writes
// =============================================================

export interface CreateExperimentInput {
  projectId: string;
  name: string;
  description?: string | null;
  type: ExperimentType;
  key: string;
  audienceId: string;
  status: ExperimentStatus;
  variants: unknown;
  metrics?: unknown;
  mutualExclusionGroup?: string | null;
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  startAfterExperimentId?: string | null;
  autoWinnerOnStop?: boolean;
}

export async function createExperiment(
  db: DbOrTx,
  input: CreateExperimentInput,
): Promise<Experiment> {
  const rows = await db
    .insert(experiments)
    .values({
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      key: input.key,
      audienceId: input.audienceId,
      status: input.status,
      variants: input.variants as typeof experiments.$inferInsert.variants,
      metrics: (input.metrics ??
        null) as typeof experiments.$inferInsert.metrics,
      mutualExclusionGroup: input.mutualExclusionGroup ?? null,
      scheduledStartAt: input.scheduledStartAt ?? null,
      scheduledEndAt: input.scheduledEndAt ?? null,
      startAfterExperimentId: input.startAfterExperimentId ?? null,
      ...(input.autoWinnerOnStop !== undefined && {
        autoWinnerOnStop: input.autoWinnerOnStop,
      }),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create experiment");
  return row;
}

export interface UpdateExperimentInput {
  name?: string;
  description?: string | null;
  type?: ExperimentType;
  // `key` is intentionally absent — experiment keys are immutable once
  // assigned (see generateExperimentKey). Updates can never change it.
  audienceId?: string;
  status?: ExperimentStatus;
  variants?: unknown;
  metrics?: unknown;
  mutualExclusionGroup?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  winnerVariantId?: string | null;
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  startAfterExperimentId?: string | null;
  autoWinnerOnStop?: boolean;
}

/**
 * Partial update for experiments. Used by both the generic PATCH
 * handler and the lifecycle endpoints (start/pause/resume/stop).
 */
export async function updateExperiment(
  db: DbOrTx,
  id: string,
  patch: UpdateExperimentInput,
): Promise<Experiment | null> {
  const data: Partial<typeof experiments.$inferInsert> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.type !== undefined) data.type = patch.type;
  if (patch.audienceId !== undefined) data.audienceId = patch.audienceId;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.variants !== undefined) {
    data.variants = patch.variants as typeof experiments.$inferInsert.variants;
  }
  if (patch.metrics !== undefined) {
    data.metrics = patch.metrics as typeof experiments.$inferInsert.metrics;
  }
  if (patch.mutualExclusionGroup !== undefined) {
    data.mutualExclusionGroup = patch.mutualExclusionGroup;
  }
  if (patch.startedAt !== undefined) data.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) data.completedAt = patch.completedAt;
  if (patch.winnerVariantId !== undefined) {
    data.winnerVariantId = patch.winnerVariantId;
  }
  if (patch.scheduledStartAt !== undefined) {
    data.scheduledStartAt = patch.scheduledStartAt;
  }
  if (patch.scheduledEndAt !== undefined) {
    data.scheduledEndAt = patch.scheduledEndAt;
  }
  if (patch.startAfterExperimentId !== undefined) {
    data.startAfterExperimentId = patch.startAfterExperimentId;
  }
  if (patch.autoWinnerOnStop !== undefined) {
    data.autoWinnerOnStop = patch.autoWinnerOnStop;
  }
  if (Object.keys(data).length === 0) return null;
  const rows = await db
    .update(experiments)
    .set(data)
    .where(eq(experiments.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Hard-delete an experiment. Cascades to experiment_assignments via
 * the FK. Callers are expected to gate this on status === "DRAFT" so
 * we don't shred running/completed analytics.
 */
export async function deleteExperiment(
  db: DbOrTx,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(experiments)
    .where(eq(experiments.id, id))
    .returning({ id: experiments.id });
  return rows.length > 0;
}

// =============================================================
// Scheduling (Task 9) — chain lookups, candidates, per-row claims
// =============================================================

/**
 * Experiments that name `predecessorId` as their `startAfterExperimentId`.
 * Called BEFORE `deleteExperiment` (same transaction) so the caller can
 * write a durable "predecessor deleted" audit marker for each dependent —
 * once the delete lands, the FK's `ON DELETE SET NULL` clears the pointer
 * and this list can never be reconstructed from the row state again.
 */
export async function findSuccessors(
  db: DbOrTx,
  predecessorId: string,
): Promise<Array<Pick<Experiment, "id" | "projectId">>> {
  return db
    .select({ id: experiments.id, projectId: experiments.projectId })
    .from(experiments)
    .where(eq(experiments.startAfterExperimentId, predecessorId));
}

/**
 * Every (id, startAfterExperimentId) pair in the project — the whole
 * dependency graph, cheap enough to walk in memory. Used by
 * `assertNoScheduleCycle` (experiment-create.ts) to reject a chain-forming
 * write before it lands, rather than detecting the cycle at scheduler
 * run time where the only options would be starting nothing or corrupting
 * bookkeeping.
 */
export async function findScheduleChainByProject(
  db: DbOrTx,
  projectId: string,
): Promise<Array<Pick<Experiment, "id" | "startAfterExperimentId">>> {
  return db
    .select({
      id: experiments.id,
      startAfterExperimentId: experiments.startAfterExperimentId,
    })
    .from(experiments)
    .where(eq(experiments.projectId, projectId));
}

/**
 * DRAFT experiments due to start: `scheduledStartAt` has arrived AND
 * (no predecessor OR the predecessor has reached COMPLETED). This is a
 * loose, non-authoritative read — the actual single-flight decision is
 * `claimExperimentForScheduledStart`'s conditional UPDATE, which
 * re-verifies both conditions atomically per row. A stale read here can
 * only produce a wasted claim attempt, never a double-start.
 */
export async function findScheduledStartCandidates(
  db: DbOrTx,
  now: Date,
): Promise<Array<Pick<Experiment, "id" | "projectId">>> {
  const rows = await db.execute(sql`
    SELECT "experiments"."id" AS "id", "experiments"."projectId" AS "projectId"
    FROM "experiments"
    LEFT JOIN "experiments" AS "predecessor"
      ON "predecessor"."id" = "experiments"."startAfterExperimentId"
    WHERE "experiments"."status" = 'DRAFT'
      AND "experiments"."scheduledStartAt" IS NOT NULL
      AND "experiments"."scheduledStartAt" <= ${now}
      AND (
        "experiments"."startAfterExperimentId" IS NULL
        OR "predecessor"."status" = 'COMPLETED'
      )
  `);
  const result = rows as unknown as { rows: Array<{ id: string; projectId: string }> };
  return result.rows ?? [];
}

/**
 * RUNNING experiments due to stop: `scheduledEndAt` has arrived. Same
 * loose-read caveat as `findScheduledStartCandidates` — the authoritative
 * check is `claimExperimentForScheduledStop`'s conditional UPDATE.
 */
export async function findScheduledStopCandidates(
  db: DbOrTx,
  now: Date,
): Promise<Array<Pick<Experiment, "id" | "projectId" | "scheduledEndAt">>> {
  return db
    .select({
      id: experiments.id,
      projectId: experiments.projectId,
      scheduledEndAt: experiments.scheduledEndAt,
    })
    .from(experiments)
    .where(
      and(
        eq(experiments.status, "RUNNING"),
        isNotNull(experiments.scheduledEndAt),
        lte(experiments.scheduledEndAt, now),
      ),
    );
}

/**
 * Atomic single-flight claim for a scheduled start. Flips DRAFT -> RUNNING
 * in ONE statement, re-checking BOTH eligibility conditions (schedule due,
 * predecessor completed) in the WHERE clause so the claim is authoritative
 * on its own, not just a status guard. Two sweeps (same process or two
 * replicas) racing on the same id: the first's UPDATE matches and commits;
 * the second's WHERE re-evaluates against the now-RUNNING row and matches
 * zero rows. This is the per-row claim pattern from the 2026-08-24
 * stability batch (`claimDeliveryForSend`) — a conditional UPDATE ...
 * RETURNING, never a SELECT followed by an UPDATE.
 *
 * The correlated subquery's columns are qualified with literal identifiers
 * rather than interpolated Drizzle column references — `${experiments.col}`
 * inside `sql` renders UNqualified, which would be ambiguous (or silently
 * wrong) once the query joins `experiments` against itself as `predecessor`.
 */
export async function claimExperimentForScheduledStart(
  db: DbOrTx,
  id: string,
  now: Date,
): Promise<Experiment | null> {
  const rows = await db
    .update(experiments)
    .set({ status: "RUNNING", startedAt: now })
    .where(
      and(
        eq(experiments.id, id),
        eq(experiments.status, "DRAFT"),
        isNotNull(experiments.scheduledStartAt),
        lte(experiments.scheduledStartAt, now),
        sql`(
          "experiments"."startAfterExperimentId" IS NULL
          OR EXISTS (
            SELECT 1 FROM "experiments" AS "predecessor"
            WHERE "predecessor"."id" = "experiments"."startAfterExperimentId"
              AND "predecessor"."status" = 'COMPLETED'
          )
        )`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Atomic single-flight claim for a scheduled stop. Rather than flipping
 * `status` directly (which the shared `stopExperimentWithWinner` transition
 * — including its placement healing — must still perform, possibly after
 * an async ClickHouse round-trip to decide `autoWinnerOnStop`'s winner),
 * this claims by clearing `scheduledEndAt`: the WHERE requires it to still
 * be non-null and due, so only one caller's UPDATE can win. The caller
 * then proceeds to `stopExperimentWithWinner`; on failure it restores
 * `scheduledEndAt` (via `updateExperiment`) so a later sweep can retry
 * rather than leaving the row claimed-but-never-stopped forever.
 */
export async function claimExperimentForScheduledStop(
  db: DbOrTx,
  id: string,
  now: Date,
): Promise<Pick<Experiment, "id" | "projectId"> | null> {
  const rows = await db
    .update(experiments)
    .set({ scheduledEndAt: null })
    .where(
      and(
        eq(experiments.id, id),
        eq(experiments.status, "RUNNING"),
        isNotNull(experiments.scheduledEndAt),
        lte(experiments.scheduledEndAt, now),
      ),
    )
    .returning({ id: experiments.id, projectId: experiments.projectId });
  return rows[0] ?? null;
}
