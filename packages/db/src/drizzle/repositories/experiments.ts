import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  experiments,
  type Experiment,
} from "../schema";

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
