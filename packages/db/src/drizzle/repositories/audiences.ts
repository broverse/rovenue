import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { audiences, type Audience } from "../schema";

// DB or Drizzle tx handle — writes accept either.
type DbOrTx = Db;

// =============================================================
// Audience reads — Drizzle repository
// =============================================================

export async function findDefaultAudience(
  db: Db,
  projectId: string,
): Promise<Pick<Audience, "id"> | null> {
  const rows = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(
      and(eq(audiences.projectId, projectId), eq(audiences.isDefault, true)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listAudiences(
  db: Db,
  projectId: string,
): Promise<Audience[]> {
  return db
    .select()
    .from(audiences)
    .where(eq(audiences.projectId, projectId))
    .orderBy(desc(audiences.isDefault), asc(audiences.name));
}

export async function findAudienceById(
  db: Db,
  id: string,
): Promise<Audience | null> {
  const rows = await db
    .select()
    .from(audiences)
    .where(eq(audiences.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findAudienceInProject(
  db: Db,
  projectId: string,
  id: string,
): Promise<Pick<Audience, "id"> | null> {
  const rows = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(and(eq(audiences.id, id), eq(audiences.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

// --- writes ---

export interface CreateAudienceInput {
  projectId: string;
  name: string;
  description?: string | null;
  rules: unknown;
  isDefault?: boolean;
}

/**
 * Insert a new audience row. Used by the dashboard project-create
 * flow to provision a default "All Users" audience alongside the
 * project.
 */
export async function createAudience(
  db: DbOrTx,
  input: CreateAudienceInput,
): Promise<Audience> {
  const rows = await db
    .insert(audiences)
    .values({
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      rules: input.rules as typeof audiences.$inferInsert.rules,
      isDefault: input.isDefault ?? false,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to create audience");
  return row;
}

export interface UpdateAudienceInput {
  name?: string;
  description?: string | null;
  rules?: unknown;
}

/**
 * Apply a partial update to an audience. The dashboard layer
 * composes this from only the body fields that were actually
 * provided by the caller.
 */
export async function updateAudience(
  db: DbOrTx,
  id: string,
  patch: UpdateAudienceInput,
): Promise<Audience | null> {
  const data: Partial<typeof audiences.$inferInsert> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.rules !== undefined) {
    data.rules = patch.rules as typeof audiences.$inferInsert.rules;
  }
  if (Object.keys(data).length === 0) return null;
  const rows = await db
    .update(audiences)
    .set(data)
    .where(eq(audiences.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Delete an audience by id. Callers must first check that it's
 * not the default ("All Users") audience and not referenced by
 * any live experiment.
 */
export async function deleteAudience(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db.delete(audiences).where(eq(audiences.id, id));
}
