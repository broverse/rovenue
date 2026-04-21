import { and, count, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  experiments,
  type Experiment,
} from "../schema";
import { experimentStatus, experimentType } from "../enums";

type DbOrTx = Db;
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
  return db
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.projectId, projectId),
        eq(experiments.status, "RUNNING"),
      ),
    );
}

export interface ExperimentFilters {
  projectId: string;
  status?: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
  type?: "FLAG" | "PRODUCT_GROUP" | "PAYWALL" | "ELEMENT";
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
  key?: string;
  audienceId?: string;
  status?: ExperimentStatus;
  variants?: unknown;
  metrics?: unknown;
  mutualExclusionGroup?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  winnerVariantId?: string | null;
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
  if (patch.key !== undefined) data.key = patch.key;
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
  if (Object.keys(data).length === 0) return null;
  const rows = await db
    .update(experiments)
    .set(data)
    .where(eq(experiments.id, id))
    .returning();
  return rows[0] ?? null;
}
