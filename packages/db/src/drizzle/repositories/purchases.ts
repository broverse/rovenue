import { eq, inArray } from "drizzle-orm";
import type { Db } from "../client";
import { products, purchases, type Purchase } from "../schema";

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
