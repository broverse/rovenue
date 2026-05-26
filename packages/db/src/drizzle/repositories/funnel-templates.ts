import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnelTemplates, type FunnelTemplate, type NewFunnelTemplate } from "../schema";

export async function listSystem(db: Db): Promise<FunnelTemplate[]> {
  return db
    .select()
    .from(funnelTemplates)
    .where(eq(funnelTemplates.scope, "system"))
    .orderBy(asc(funnelTemplates.category), asc(funnelTemplates.name));
}

export async function findById(db: Db, id: string): Promise<FunnelTemplate | null> {
  const rows = await db
    .select()
    .from(funnelTemplates)
    .where(eq(funnelTemplates.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(
  db: Db,
  row: NewFunnelTemplate,
): Promise<FunnelTemplate> {
  const [inserted] = await db.insert(funnelTemplates).values(row).returning();
  return inserted;
}

export async function listByProject(
  db: Db,
  projectId: string,
): Promise<FunnelTemplate[]> {
  return db
    .select()
    .from(funnelTemplates)
    .where(
      and(eq(funnelTemplates.scope, "user"), eq(funnelTemplates.projectId, projectId)),
    )
    .orderBy(asc(funnelTemplates.name));
}
