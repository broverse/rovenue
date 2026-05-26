import { desc, eq, max } from "drizzle-orm";
import type { Db } from "../client";
import { funnelVersions, type FunnelVersion, type NewFunnelVersion } from "../schema";

export async function findById(db: Db, id: string): Promise<FunnelVersion | null> {
  const rows = await db.select().from(funnelVersions).where(eq(funnelVersions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listByFunnel(db: Db, funnelId: string): Promise<FunnelVersion[]> {
  return db
    .select()
    .from(funnelVersions)
    .where(eq(funnelVersions.funnelId, funnelId))
    .orderBy(desc(funnelVersions.versionNo));
}

export async function nextVersionNo(db: Db, funnelId: string): Promise<number> {
  const [row] = await db
    .select({ v: max(funnelVersions.versionNo) })
    .from(funnelVersions)
    .where(eq(funnelVersions.funnelId, funnelId));
  return (row?.v ?? 0) + 1;
}

export async function insert(db: Db, row: NewFunnelVersion): Promise<FunnelVersion> {
  const [inserted] = await db.insert(funnelVersions).values(row).returning();
  return inserted;
}
