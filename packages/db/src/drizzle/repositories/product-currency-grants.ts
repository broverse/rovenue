import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { productCurrencyGrants, type ProductCurrencyGrantRow } from "../schema";

export async function setProductGrants(
  db: Db,
  productId: string,
  grants: Array<{ currencyId: string; amount: number }>,
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
