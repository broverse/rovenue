import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../client";
import { funnelSessions, type FunnelSession, type NewFunnelSession } from "../schema";

export async function insert(db: Db, row: NewFunnelSession): Promise<FunnelSession> {
  const [inserted] = await db.insert(funnelSessions).values(row).returning();
  return inserted;
}

export async function findById(db: Db, id: string): Promise<FunnelSession | null> {
  const rows = await db
    .select()
    .from(funnelSessions)
    .where(eq(funnelSessions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function setCurrentPage(
  db: Db,
  id: string,
  pageId: string,
): Promise<void> {
  await db
    .update(funnelSessions)
    .set({ currentPageId: pageId, lastActivityAt: new Date() })
    .where(eq(funnelSessions.id, id));
}

export async function setState(
  db: Db,
  id: string,
  state: FunnelSession["state"],
): Promise<void> {
  const completed = state === "completed" ? { completedAt: new Date() } : {};
  await db
    .update(funnelSessions)
    .set({ state, lastActivityAt: new Date(), ...completed })
    .where(eq(funnelSessions.id, id));
}

export async function markAbandonedOlderThan(
  db: Db,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .update(funnelSessions)
    .set({ state: "abandoned" })
    .where(
      and(
        eq(funnelSessions.state, "in_progress"),
        lt(funnelSessions.lastActivityAt, cutoff),
      ),
    )
    .returning({ id: funnelSessions.id });
  return rows.length;
}

export async function listByFunnel(
  db: Db,
  funnelId: string,
  limit = 50,
  offset = 0,
): Promise<FunnelSession[]> {
  return db
    .select()
    .from(funnelSessions)
    .where(eq(funnelSessions.funnelId, funnelId))
    .limit(limit)
    .offset(offset);
}
