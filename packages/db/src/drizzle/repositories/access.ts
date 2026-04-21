import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "../client";
import { subscriberAccess, type SubscriberAccessRow } from "../schema";

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
