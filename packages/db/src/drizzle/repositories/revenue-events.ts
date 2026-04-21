import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../client";
import { revenueEvents, type RevenueEvent } from "../schema";

// =============================================================
// Revenue event reads — Drizzle repository
// =============================================================

/**
 * Dedup guard used by expiry-checker: has the subscriber already
 * had a CANCELLATION revenue event written since `since`? If yes,
 * skip emitting a duplicate.
 */
export async function findRecentRevenueEvent(
  db: Db,
  subscriberId: string,
  purchaseId: string,
  type:
    | "INITIAL"
    | "RENEWAL"
    | "TRIAL_CONVERSION"
    | "CANCELLATION"
    | "REFUND"
    | "REACTIVATION"
    | "CREDIT_PURCHASE",
  since: Date,
): Promise<RevenueEvent | null> {
  const rows = await db
    .select()
    .from(revenueEvents)
    .where(
      and(
        eq(revenueEvents.subscriberId, subscriberId),
        eq(revenueEvents.purchaseId, purchaseId),
        eq(revenueEvents.type, type),
        gte(revenueEvents.createdAt, since),
      ),
    )
    .orderBy(desc(revenueEvents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
