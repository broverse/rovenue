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
