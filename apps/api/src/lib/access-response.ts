import { drizzle } from "@rovenue/db";
import { getActiveAccess } from "../services/access-engine";

export interface AccessResponseEntry {
  isActive: boolean;
  expiresDate: string | null;
  store: string;
  productIdentifier: string;
}

/**
 * Builds the access map the SDK consumes — entitlement key →
 * isActive / expiresDate / store / productIdentifier. The shape is
 * shared between `/v1/receipts/*`, `/v1/subscribers/:appUserId/access`,
 * and `/v1/me/entitlements` so clients see one response schema.
 */
export async function buildAccessResponse(
  subscriberId: string,
): Promise<Record<string, AccessResponseEntry>> {
  const raw = await getActiveAccess(subscriberId);
  const purchaseIds = Array.from(
    new Set(Object.values(raw).map((entry) => entry.purchaseId)),
  );

  const purchases = await drizzle.purchaseRepo.findPurchasesByIds(
    drizzle.db,
    purchaseIds,
  );
  const productByPurchase = new Map(
    purchases.map((p) => [p.id, p.product.identifier] as const),
  );

  const result: Record<string, AccessResponseEntry> = {};
  for (const [key, entry] of Object.entries(raw)) {
    result[key] = {
      isActive: entry.isActive,
      expiresDate: entry.expiresDate ? entry.expiresDate.toISOString() : null,
      store: entry.store,
      productIdentifier:
        productByPurchase.get(entry.purchaseId) ?? "unknown",
    };
  }
  return result;
}
