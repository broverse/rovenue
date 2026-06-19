import { drizzle } from "@rovenue/db";
import { addCredits } from "./credit-engine";

// =============================================================
// purchase-credits — bundle-currency grant service
// =============================================================
//
// Grants every virtual currency in a product's product_currency_grants
// table when a consumable IAP is purchased. Idempotent: duplicate calls
// with the same purchaseId are safe — addCredits dedupes on
// (referenceType="purchase", referenceId=purchaseId, currencyId).
//
// Extracted as a standalone service (not inlined in receipts.ts) so
// the webhook-processor can reuse it without a route→service→route
// import cycle.

export interface GrantPurchaseCurrenciesArgs {
  subscriberId: string;
  productId: string;
  purchaseId: string;
  productIdentifier: string;
}

export async function grantPurchaseCurrencies(
  args: GrantPurchaseCurrenciesArgs,
): Promise<void> {
  const grants = await drizzle.productCurrencyGrantRepo.listProductGrants(
    drizzle.db,
    args.productId,
  );
  for (const grant of grants) {
    if (grant.amount <= 0) continue;
    await addCredits({
      subscriberId: args.subscriberId,
      currencyId: grant.currencyId,
      amount: grant.amount,
      referenceType: "purchase",
      referenceId: args.purchaseId,
      description: `Credits for ${args.productIdentifier}`,
      dedupeOnReference: true,
    });
  }
}
