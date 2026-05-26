import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  funnelClaimTokens,
  type FunnelClaimToken,
  type NewFunnelClaimToken,
} from "../schema";

export async function insert(
  db: Db,
  row: NewFunnelClaimToken,
): Promise<FunnelClaimToken> {
  const [inserted] = await db.insert(funnelClaimTokens).values(row).returning();
  return inserted;
}

export async function findByHash(
  db: Db,
  tokenHash: string,
): Promise<FunnelClaimToken | null> {
  const rows = await db
    .select()
    .from(funnelClaimTokens)
    .where(eq(funnelClaimTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findBySession(
  db: Db,
  sessionId: string,
): Promise<FunnelClaimToken | null> {
  const rows = await db
    .select()
    .from(funnelClaimTokens)
    .where(eq(funnelClaimTokens.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findByEmailHash(
  db: Db,
  projectId: string,
  emailHash: string,
): Promise<FunnelClaimToken | null> {
  const rows = await db
    .select()
    .from(funnelClaimTokens)
    .where(
      and(
        eq(funnelClaimTokens.projectId, projectId),
        eq(funnelClaimTokens.emailHash, emailHash),
        isNull(funnelClaimTokens.claimedAt),
      ),
    )
    .orderBy(sql`${funnelClaimTokens.createdAt} desc`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomic claim via UPDATE ... WHERE claimed_at IS NULL.
 * Returns the row if this caller won, null if already claimed.
 */
export async function tryClaim(
  db: Db,
  id: string,
  subscriberId: string,
): Promise<FunnelClaimToken | null> {
  const [updated] = await db
    .update(funnelClaimTokens)
    .set({ claimedAt: new Date(), claimedBySubscriberId: subscriberId })
    .where(
      and(eq(funnelClaimTokens.id, id), isNull(funnelClaimTokens.claimedAt)),
    )
    .returning();
  return updated ?? null;
}

export async function markExpired(db: Db, now: Date): Promise<number> {
  const rows = await db
    .delete(funnelClaimTokens)
    .where(and(lt(funnelClaimTokens.expiresAt, now), isNull(funnelClaimTokens.claimedAt)))
    .returning({ id: funnelClaimTokens.id });
  return rows.length;
}
