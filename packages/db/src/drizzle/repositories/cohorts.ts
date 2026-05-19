import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { cohorts, type Cohort, type NewCohort } from "../schema";

// =============================================================
// cohorts repository (Phase 4.4)
// =============================================================
//
// Project-scoped CRUD. Uniqueness on (projectId, name) is enforced
// by the table-level uniqueIndex; the route surfaces the collision
// as a friendly 409 before the INSERT to keep the error message
// human-readable.

export async function listCohorts(
  db: Db,
  projectId: string,
): Promise<Cohort[]> {
  return db
    .select()
    .from(cohorts)
    .where(eq(cohorts.projectId, projectId))
    .orderBy(desc(cohorts.updatedAt));
}

export async function findCohortById(
  db: Db,
  projectId: string,
  id: string,
): Promise<Cohort | null> {
  const rows = await db
    .select()
    .from(cohorts)
    .where(and(eq(cohorts.projectId, projectId), eq(cohorts.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCohortByName(
  db: Db,
  projectId: string,
  name: string,
): Promise<Cohort | null> {
  const rows = await db
    .select()
    .from(cohorts)
    .where(and(eq(cohorts.projectId, projectId), eq(cohorts.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createCohort(
  db: Db,
  input: NewCohort,
): Promise<Cohort> {
  const [row] = await db.insert(cohorts).values(input).returning();
  return row!;
}

export interface UpdateCohortInput {
  name?: string;
  description?: string | null;
  rules?: Record<string, unknown>;
  syncDestinations?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
}

export async function updateCohort(
  db: Db,
  projectId: string,
  id: string,
  patch: UpdateCohortInput,
): Promise<Cohort | null> {
  const [row] = await db
    .update(cohorts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(cohorts.projectId, projectId), eq(cohorts.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteCohort(
  db: Db,
  projectId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(cohorts)
    .where(and(eq(cohorts.projectId, projectId), eq(cohorts.id, id)))
    .returning({ id: cohorts.id });
  return rows.length > 0;
}
