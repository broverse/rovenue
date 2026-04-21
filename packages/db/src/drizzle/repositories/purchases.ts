import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client";
import { products, purchases, type Purchase } from "../schema";
import { store as storeEnum } from "../enums";

type DbOrTx = Db;
type Store = (typeof storeEnum.enumValues)[number];

// =============================================================
// Purchase reads — Drizzle repository
// =============================================================

/**
 * Fetches purchases by id with the product identifier inlined.
 * Mirrors prisma.purchase.findMany({ where: { id: { in } },
 * include: { product: { select: { identifier } } } }).
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
 * SET …. Mirrors prisma.purchase.upsert({
 *   where: { store_storeTransactionId: { store, storeTransactionId } },
 *   create, update,
 * }). Returns the final row (inserted or updated) via .returning().
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
