import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { savedQueries, type NewSavedQuery, type SavedQuery } from "../schema";

// =============================================================
// saved_queries repository (Phase 4.5)
// =============================================================

export async function listSavedQueries(
  db: Db,
  projectId: string,
  userId: string,
): Promise<SavedQuery[]> {
  return db
    .select()
    .from(savedQueries)
    .where(
      and(
        eq(savedQueries.projectId, projectId),
        eq(savedQueries.userId, userId),
      ),
    )
    .orderBy(desc(savedQueries.updatedAt));
}

export async function findSavedQueryById(
  db: Db,
  id: string,
  projectId: string,
  userId: string,
): Promise<SavedQuery | null> {
  const rows = await db
    .select()
    .from(savedQueries)
    .where(
      and(
        eq(savedQueries.id, id),
        eq(savedQueries.projectId, projectId),
        eq(savedQueries.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createSavedQuery(
  db: Db,
  input: NewSavedQuery,
): Promise<SavedQuery> {
  const [row] = await db.insert(savedQueries).values(input).returning();
  return row!;
}

export interface UpdateSavedQueryInput {
  name?: string;
  description?: string | null;
  sql?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

export async function updateSavedQuery(
  db: Db,
  id: string,
  projectId: string,
  userId: string,
  patch: UpdateSavedQueryInput,
): Promise<SavedQuery | null> {
  const [row] = await db
    .update(savedQueries)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(savedQueries.id, id),
        eq(savedQueries.projectId, projectId),
        eq(savedQueries.userId, userId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteSavedQuery(
  db: Db,
  id: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(savedQueries)
    .where(
      and(
        eq(savedQueries.id, id),
        eq(savedQueries.projectId, projectId),
        eq(savedQueries.userId, userId),
      ),
    )
    .returning({ id: savedQueries.id });
  return rows.length > 0;
}
