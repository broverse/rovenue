import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { products, purchases, type Purchase } from "../schema";
import { purchaseStatus, store as storeEnum } from "../enums";

type DbOrTx = Db;
type Store = (typeof storeEnum.enumValues)[number];
type PurchaseStatus = (typeof purchaseStatus.enumValues)[number];

// =============================================================
// Purchase reads
// =============================================================

/**
 * Fetches purchases by id with the product identifier inlined.
 */
export interface PurchaseWithProductIdentifier extends Purchase {
  product: { identifier: string };
}

export async function findPurchasesByIds(
  db: Db,
  ids: string[],
): Promise<PurchaseWithProductIdentifier[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      purchase: purchases,
      productIdentifier: products.identifier,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(inArray(purchases.id, ids));
  return rows.map((r) => ({
    ...(r.purchase as Purchase),
    product: { identifier: r.productIdentifier },
  }));
}

// =============================================================
// Writes — upsert
// =============================================================

export type NewPurchaseFields = typeof purchases.$inferInsert;
export type UpdatePurchaseFields = Partial<typeof purchases.$inferInsert>;

/**
 * INSERT ... ON CONFLICT (store, storeTransactionId) DO UPDATE
 * SET …. Returns the final row (inserted or updated) via
 * .returning().
 */
export async function upsertPurchase(
  db: DbOrTx,
  args: {
    store: Store;
    storeTransactionId: string;
    create: NewPurchaseFields;
    update: UpdatePurchaseFields;
  },
): Promise<Purchase> {
  const rows = await db
    .insert(purchases)
    .values(args.create)
    .onConflictDoUpdate({
      target: [purchases.store, purchases.storeTransactionId],
      set: args.update,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertPurchase: no row returned");
  return row;
}

/**
 * Partial update keyed on the primary id. Used by the Apple and
 * Google webhook handlers when they need to record renewal /
 * cancellation state.
 */
export async function updatePurchase(
  db: DbOrTx,
  id: string,
  patch: UpdatePurchaseFields,
): Promise<Purchase | null> {
  if (Object.keys(patch).length === 0) return null;
  const rows = await db
    .update(purchases)
    .set(patch)
    .where(eq(purchases.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Bulk update every purchase row whose originalTransactionId
 * matches, within a single project. The Apple webhook uses this
 * to propagate a refund or expiration across every purchase in
 * the transaction chain.
 */
export async function updatePurchasesByOriginalTransaction(
  db: DbOrTx,
  projectId: string,
  originalTransactionId: string,
  patch: UpdatePurchaseFields,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db
    .update(purchases)
    .set(patch)
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.originalTransactionId, originalTransactionId),
      ),
    );
}

/**
 * Partial update keyed on (store, storeTransactionId). Both
 * Stripe's invoice.payment_failed and Google's voided-purchase
 * paths need to transition a row without first looking it up by
 * id.
 */
export async function updatePurchaseByStoreTransaction(
  db: DbOrTx,
  store: Store,
  storeTransactionId: string,
  patch: UpdatePurchaseFields,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db
    .update(purchases)
    .set(patch)
    .where(
      and(
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    );
}

/**
 * Compare-and-swap status flip for the expiry worker.
 * `WHERE id = $1 AND status = $2` ensures two concurrent workers
 * can't both transition the same row — the second one sees 0 rows
 * updated and skips. Returns the count of rows actually updated.
 */
export async function updatePurchaseStatusIf(
  db: DbOrTx,
  id: string,
  expectedStatus: PurchaseStatus,
  newStatus: PurchaseStatus,
): Promise<number> {
  const result = await db
    .update(purchases)
    .set({ status: newStatus })
    .where(
      and(eq(purchases.id, id), eq(purchases.status, expectedStatus)),
    )
    .returning({ id: purchases.id });
  return result.length;
}
