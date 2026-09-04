import { and, eq, inArray } from "drizzle-orm";
import { grantTriggersMatching, type CurrencyGrantTrigger, type GrantEventTrigger } from "@rovenue/shared";
import type { Db } from "../client";
import { productCurrencyGrants, type ProductCurrencyGrantRow } from "../schema";

export async function setProductGrants(
  db: Db,
  productId: string,
  grants: Array<{ currencyId: string; amount: number; grantOn?: CurrencyGrantTrigger }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(productCurrencyGrants)
      .where(eq(productCurrencyGrants.productId, productId));
    if (grants.length > 0) {
      await tx.insert(productCurrencyGrants).values(
        grants.map((g) => ({
          productId,
          currencyId: g.currencyId,
          amount: g.amount,
          grantOn: g.grantOn ?? "PURCHASE",
        })),
      );
    }
  });
}

export async function listProductGrants(
  db: Db,
  productId: string,
): Promise<ProductCurrencyGrantRow[]> {
  return db
    .select()
    .from(productCurrencyGrants)
    .where(eq(productCurrencyGrants.productId, productId));
}

/**
 * Grants for a product that fire on `trigger`. Filtering in SQL rather
 * than in the caller keeps the renewal hot path to one indexed read that
 * returns nothing at all for the overwhelmingly common case — a
 * subscription with no currency grants configured.
 */
export async function listProductGrantsForTrigger(
  db: Db,
  productId: string,
  trigger: GrantEventTrigger,
): Promise<ProductCurrencyGrantRow[]> {
  // Derived from the shared matrix, never re-hardcoded here.
  const matching = grantTriggersMatching(trigger);

  return db
    .select()
    .from(productCurrencyGrants)
    .where(
      and(
        eq(productCurrencyGrants.productId, productId),
        inArray(productCurrencyGrants.grantOn, matching),
      ),
    );
}
