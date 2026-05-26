import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  funnelDeferredClaims,
  type FunnelDeferredClaim,
  type NewFunnelDeferredClaim,
} from "../schema";

export async function insert(
  db: Db,
  row: NewFunnelDeferredClaim,
): Promise<FunnelDeferredClaim> {
  const [inserted] = await db.insert(funnelDeferredClaims).values(row).returning();
  return inserted;
}

export async function findRecentByIpHash(
  db: Db,
  ipHash: string,
  now: Date,
): Promise<FunnelDeferredClaim[]> {
  return db
    .select()
    .from(funnelDeferredClaims)
    .where(
      and(
        eq(funnelDeferredClaims.ipHash, ipHash),
        gte(funnelDeferredClaims.expiresAt, now),
        isNull(funnelDeferredClaims.matchedAt),
      ),
    )
    .orderBy(sql`${funnelDeferredClaims.createdAt} desc`)
    .limit(20);
}

export async function markMatched(
  db: Db,
  id: string,
  installId: string,
): Promise<void> {
  await db
    .update(funnelDeferredClaims)
    .set({ matchedAt: new Date(), matchedInstallId: installId })
    .where(eq(funnelDeferredClaims.id, id));
}

export async function deleteExpired(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(funnelDeferredClaims)
    .where(lt(funnelDeferredClaims.expiresAt, now))
    .returning({ id: funnelDeferredClaims.id });
  return rows.length;
}
