import { drizzle } from "@rovenue/db";
import { getActiveAccess } from "../services/access-engine";

export interface AccessResponseEntry {
  isActive: boolean;
  expiresDate: string | null;
  store: string;
  productIdentifier: string;
}

/**
 * Builds the access map the SDK consumes — access identifier →
 * isActive / expiresDate / store / productIdentifier. The shape is
 * shared between `/v1/receipts/*`, `/v1/subscribers/:appUserId/access`,
 * and `/v1/me` so clients see one response schema.
 *
 * Internally `subscriber_access.accessId` is a cuid2 FK to `access.id`,
 * but the SDK-facing key stays the human-readable `access.identifier`
 * (e.g. `"pro"`). We resolve the FK → identifier here.
 */
export async function buildAccessResponse(
  subscriberId: string,
): Promise<Record<string, AccessResponseEntry>> {
  const raw = await getActiveAccess(subscriberId);
  const accessIds = Object.keys(raw);
  if (accessIds.length === 0) return {};

  const purchaseIds = Array.from(
    new Set(Object.values(raw).map((entry) => entry.purchaseId)),
  );

  const [purchases, accessRows] = await Promise.all([
    drizzle.purchaseRepo.findPurchasesByIds(drizzle.db, purchaseIds),
    drizzle.accessCatalogRepo.findByIds(drizzle.db, accessIds),
  ]);

  const productByPurchase = new Map(
    purchases.map((p) => [p.id, p.product.identifier] as const),
  );
  const identifierByAccessId = new Map(
    accessRows.map((a) => [a.id, a.identifier] as const),
  );

  const result: Record<string, AccessResponseEntry> = {};
  for (const [accessId, entry] of Object.entries(raw)) {
    const identifier = identifierByAccessId.get(accessId);
    if (!identifier) continue; // access row was deleted — skip
    result[identifier] = {
      isActive: entry.isActive,
      expiresDate: entry.expiresDate ? entry.expiresDate.toISOString() : null,
      store: entry.store,
      productIdentifier:
        productByPurchase.get(entry.purchaseId) ?? "unknown",
    };
  }
  return result;
}
