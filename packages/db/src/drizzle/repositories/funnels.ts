import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnels, type Funnel, type NewFunnel } from "../schema";

export async function listByProject(
  db: Db,
  projectId: string,
  opts: { status?: Funnel["status"]; limit?: number; offset?: number } = {},
): Promise<Funnel[]> {
  const where = opts.status
    ? and(eq(funnels.projectId, projectId), eq(funnels.status, opts.status))
    : eq(funnels.projectId, projectId);
  return db
    .select()
    .from(funnels)
    .where(where)
    .orderBy(desc(funnels.updatedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

export async function findById(db: Db, id: string): Promise<Funnel | null> {
  const rows = await db.select().from(funnels).where(eq(funnels.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findBySlug(
  db: Db,
  projectId: string,
  slug: string,
): Promise<Funnel | null> {
  const rows = await db
    .select()
    .from(funnels)
    .where(and(eq(funnels.projectId, projectId), eq(funnels.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insert(db: Db, row: NewFunnel): Promise<Funnel> {
  const [inserted] = await db.insert(funnels).values(row).returning();
  return inserted;
}

export async function updateById(
  db: Db,
  id: string,
  patch: Partial<NewFunnel>,
): Promise<Funnel | null> {
  const [updated] = await db
    .update(funnels)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(funnels.id, id))
    .returning();
  return updated ?? null;
}

export async function setCurrentVersion(
  db: Db,
  id: string,
  versionId: string,
): Promise<void> {
  await db
    .update(funnels)
    .set({ currentVersionId: versionId, status: "published", updatedAt: new Date() })
    .where(eq(funnels.id, id));
}

export async function archive(db: Db, id: string): Promise<void> {
  await db
    .update(funnels)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(funnels.id, id));
}
