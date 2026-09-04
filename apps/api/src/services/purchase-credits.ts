import { drizzle } from "@rovenue/db";
import type { GrantEventTrigger } from "@rovenue/shared";
import { addCredits } from "./credit-engine";

// =============================================================
// purchase-credits — product currency grant service
// =============================================================
//
// Grants every virtual currency configured on a product for a given
// lifecycle trigger. Idempotent: addCredits dedupes on
// (referenceType, referenceId, currencyId), so a duplicate webhook or a
// Kafka redelivery grants nothing further.
//
// The two reference types are deliberately distinct. A consumable
// purchase keyed on a purchaseId and a renewal keyed on a
// revenueEventId could in principle collide; a shared referenceType
// would let one silently swallow the other.

export const GRANT_REFERENCE_TYPE: Record<GrantEventTrigger, string> = {
  PURCHASE: "purchase",
  RENEWAL: "renewal",
};

export interface GrantProductCurrenciesArgs {
  subscriberId: string;
  productId: string;
  /** purchaseId for PURCHASE, revenueEventId for RENEWAL. */
  referenceId: string;
  productIdentifier: string;
  trigger: GrantEventTrigger;
}

export async function grantProductCurrencies(
  args: GrantProductCurrenciesArgs,
): Promise<void> {
  const grants =
    await drizzle.productCurrencyGrantRepo.listProductGrantsForTrigger(
      drizzle.db,
      args.productId,
      args.trigger,
    );

  for (const grant of grants) {
    if (grant.amount <= 0) continue;
    await addCredits({
      subscriberId: args.subscriberId,
      currencyId: grant.currencyId,
      amount: grant.amount,
      referenceType: GRANT_REFERENCE_TYPE[args.trigger],
      referenceId: args.referenceId,
      description: `Credits for ${args.productIdentifier}`,
      dedupeOnReference: true,
    });
  }
}
