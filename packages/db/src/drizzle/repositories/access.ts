import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../client";
import {
  purchases,
  subscriberAccess,
  type SubscriberAccessRow,
} from "../schema";

/**
 * First subscriberAccess row matching (subscriberId, purchaseId,
 * entitlementKey). Webhook services call this to decide whether
 * to insert a new access row or flip the existing one back to
 * active.
 */
export async function findAccessByPurchaseAndKey(
  db: Db,
  subscriberId: string,
  purchaseId: string,
  entitlementKey: string,
): Promise<SubscriberAccessRow | null> {
  const rows = await db
    .select()
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.purchaseId, purchaseId),
        eq(subscriberAccess.entitlementKey, entitlementKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * IDs of subscriber_access rows joined on a purchase chain —
 * "every access row whose purchase has this originalTransactionId
 * within the given project". Used by apple-webhook to revoke
 * access when a transaction chain expires or refunds.
 */
export async function findAccessIdsForPurchaseChain(
  db: Db,
  projectId: string,
  originalTransactionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: subscriberAccess.id })
    .from(subscriberAccess)
    .innerJoin(purchases, eq(purchases.id, subscriberAccess.purchaseId))
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.originalTransactionId, originalTransactionId),
      ),
    );
  return rows.map((r) => r.id);
}

// Re-export for callers that compose IN () clauses on top.
export { inArray };

// =============================================================
// Entitlement access reads — Drizzle repository
// =============================================================
//
// Mirrors prisma.subscriberAccess.findMany({ where: { subscriberId,
// isActive: true, OR: [{ expiresDate: null }, { expiresDate: { gt } }]
// } }) used by apps/api/src/services/access-engine.ts. The
// non-expired + active filter defines "live" entitlement: either
// perpetual (null expiry) or not yet past expiresDate.

export async function findActiveAccess(
  db: Db,
  subscriberId: string,
  now: Date = new Date(),
): Promise<SubscriberAccessRow[]> {
  return db
    .select()
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.isActive, true),
        or(
          isNull(subscriberAccess.expiresDate),
          gt(subscriberAccess.expiresDate, now),
        )!,
      ),
    );
}
