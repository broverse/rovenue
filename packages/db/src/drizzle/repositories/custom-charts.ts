import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  customCharts,
  type CustomChart,
  type NewCustomChart,
} from "../schema";

// =============================================================
// custom_charts repository
// =============================================================
//
// Per-project, project-shared chart definitions. Writes go
// through ADMIN-gated routes (see apps/api/src/routes/dashboard/
// charts.ts); this layer is intentionally thin and unaware of
// auth — that policy lives at the route boundary.

export async function listCustomCharts(
  db: Db,
  projectId: string,
): Promise<CustomChart[]> {
  return db
    .select()
    .from(customCharts)
    .where(eq(customCharts.projectId, projectId))
    .orderBy(asc(customCharts.createdAt));
}

export async function findCustomChartById(
  db: Db,
  id: string,
  projectId: string,
): Promise<CustomChart | null> {
  const rows = await db
    .select()
    .from(customCharts)
    .where(and(eq(customCharts.id, id), eq(customCharts.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createCustomChart(
  db: Db,
  input: NewCustomChart,
): Promise<CustomChart> {
  const [row] = await db.insert(customCharts).values(input).returning();
  return row!;
}

export interface UpdateCustomChartInput {
  name?: string;
  category?: string;
  chartType?: string;
  rangeOption?: string;
  config?: Record<string, unknown>;
}

export async function updateCustomChart(
  db: Db,
  id: string,
  projectId: string,
  patch: UpdateCustomChartInput,
): Promise<CustomChart | null> {
  const [row] = await db
    .update(customCharts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(customCharts.id, id), eq(customCharts.projectId, projectId)))
    .returning();
  return row ?? null;
}

export async function deleteCustomChart(
  db: Db,
  id: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .delete(customCharts)
    .where(and(eq(customCharts.id, id), eq(customCharts.projectId, projectId)))
    .returning({ id: customCharts.id });
  return rows.length > 0;
}

