import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { savedChartViews, type NewSavedChartView, type SavedChartView } from "../schema";

// =============================================================
// saved_chart_views repository
// =============================================================
//
// Per-user chart configurations. CRUD is project-scoped; we
// double-check `userId` ownership on update/delete to keep
// teammates from clobbering each other's saved views.

export async function listSavedViews(
  db: Db,
  projectId: string,
  userId: string,
): Promise<SavedChartView[]> {
  return db
    .select()
    .from(savedChartViews)
    .where(
      and(
        eq(savedChartViews.projectId, projectId),
        eq(savedChartViews.userId, userId),
      ),
    )
    .orderBy(desc(savedChartViews.updatedAt));
}

export async function findSavedViewById(
  db: Db,
  id: string,
  projectId: string,
  userId: string,
): Promise<SavedChartView | null> {
  const rows = await db
    .select()
    .from(savedChartViews)
    .where(
      and(
        eq(savedChartViews.id, id),
        eq(savedChartViews.projectId, projectId),
        eq(savedChartViews.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createSavedView(
  db: Db,
  input: NewSavedChartView,
): Promise<SavedChartView> {
  const [row] = await db.insert(savedChartViews).values(input).returning();
  return row!;
}

export interface UpdateSavedViewInput {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
}

export async function updateSavedView(
  db: Db,
  id: string,
  projectId: string,
  userId: string,
  patch: UpdateSavedViewInput,
): Promise<SavedChartView | null> {
  const [row] = await db
    .update(savedChartViews)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(savedChartViews.id, id),
        eq(savedChartViews.projectId, projectId),
        eq(savedChartViews.userId, userId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteSavedView(
  db: Db,
  id: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(savedChartViews)
    .where(
      and(
        eq(savedChartViews.id, id),
        eq(savedChartViews.projectId, projectId),
        eq(savedChartViews.userId, userId),
      ),
    )
    .returning({ id: savedChartViews.id });
  return rows.length > 0;
}
