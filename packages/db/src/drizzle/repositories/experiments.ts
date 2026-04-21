import { and, count, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  experiments,
  type Experiment,
} from "../schema";

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
