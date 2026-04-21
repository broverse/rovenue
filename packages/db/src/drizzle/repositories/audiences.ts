import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { audiences, type Audience } from "../schema";

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
  db: Db,
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
