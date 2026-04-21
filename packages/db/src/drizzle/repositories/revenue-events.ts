import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../client";
import { revenueEvents, type RevenueEvent } from "../schema";
import { revenueEventType, store as storeEnum } from "../enums";

type DbOrTx = Db;
type Store = (typeof storeEnum.enumValues)[number];
type RevenueEventType = (typeof revenueEventType.enumValues)[number];

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
  type: RevenueEventType,
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

// =============================================================
// Writes
// =============================================================

export interface CreateRevenueEventInput {
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: RevenueEventType;
  amount: string;
  currency: string;
  amountUsd: string;
  store: Store;
  eventDate: Date;
}

/**
 * Append a new revenue_events row. The table is append-only by
 * convention (analytics love immutability) — callers never UPDATE
 * an existing row, they always insert a new one for the latest
 * observation of the same purchase.
 */
export async function createRevenueEvent(
  db: DbOrTx,
  input: CreateRevenueEventInput,
): Promise<void> {
  await db.insert(revenueEvents).values({
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    purchaseId: input.purchaseId,
    productId: input.productId,
    type: input.type,
    amount: input.amount,
    currency: input.currency,
    amountUsd: input.amountUsd,
    store: input.store,
    eventDate: input.eventDate,
  });
}
