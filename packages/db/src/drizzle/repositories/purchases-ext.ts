import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import { products, purchases, type Purchase } from "../schema";

// =============================================================
// Extended purchase reads — used by webhook handlers + workers
// =============================================================
//
// Separated from repositories/purchases.ts (dashboard fan-out)
// so each module stays focused on one caller type.

/**
 * Lookup a purchase by its store-side transaction id. Mirrors
 * prisma.purchase.findUnique({ where: { store_storeTransactionId } }).
 * Composite-unique index over (store, storeTransactionId).
 */
export async function findPurchaseByStoreTransaction(
  db: Db,
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE",
  storeTransactionId: string,
): Promise<Purchase | null> {
  const rows = await db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * First purchase under a project that matches the Apple
 * `originalTransactionId` — used by apple-webhook to reconnect
 * renewals/refunds to the subscriber record.
 */
export async function findPurchaseByOriginalTransaction(
  db: Db,
  projectId: string,
  originalTransactionId: string,
): Promise<Purchase | null> {
  const rows = await db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.originalTransactionId, originalTransactionId),
      ),
    )
    .orderBy(desc(purchases.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * All purchases under a project with a given originalTransactionId
 * — needed when the apple-webhook needs to bulk-update every
 * renewal chain row.
 */
export async function listPurchasesByOriginalTransaction(
  db: Db,
  projectId: string,
  originalTransactionId: string,
): Promise<Purchase[]> {
  return db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.originalTransactionId, originalTransactionId),
      ),
    );
}

/**
 * Find a single purchase by id with the product's `type` and
 * `creditAmount` joined. Used by webhook-processor to decide
 * whether a completed consumable purchase earns credits.
 */
export interface PurchaseWithCreditInfo {
  id: string;
  subscriberId: string;
  product: { type: string; creditAmount: number | null };
}

export async function findPurchaseWithCreditInfo(
  db: Db,
  id: string,
): Promise<PurchaseWithCreditInfo | null> {
  const rows = await db
    .select({
      id: purchases.id,
      subscriberId: purchases.subscriberId,
      productType: products.type,
      creditAmount: products.creditAmount,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(eq(purchases.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    subscriberId: r.subscriberId,
    product: { type: r.productType, creditAmount: r.creditAmount },
  };
}

/**
 * Purchases owned by a subscriber with the product's entitlement
 * keys joined in one query. Used by access-engine's syncAccess
 * to reconcile entitlement grants against current purchases.
 */
export interface PurchaseWithEntitlements {
  id: string;
  subscriberId: string;
  status: Purchase["status"];
  expiresDate: Date | null;
  store: Purchase["store"];
  entitlementKeys: string[];
}

export async function findPurchasesForSubscriberWithEntitlements(
  db: Db,
  subscriberId: string,
): Promise<PurchaseWithEntitlements[]> {
  const rows = await db
    .select({
      id: purchases.id,
      subscriberId: purchases.subscriberId,
      status: purchases.status,
      expiresDate: purchases.expiresDate,
      store: purchases.store,
      entitlementKeys: products.entitlementKeys,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(eq(purchases.subscriberId, subscriberId));
  return rows;
}

/**
 * Expiry sweeper helper — pulls purchases with an expiresDate in
 * the `(lookback, now]` window whose status is one of the supplied
 * candidates. Caller picks the selection list based on its
 * sweeper policy (e.g. ACTIVE + GRACE_PERIOD + TRIAL).
 */
export interface ExpiryCandidate {
  id: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  status: Purchase["status"];
  store: Purchase["store"];
  expiresDate: Date | null;
  gracePeriodExpires: Date | null;
  priceAmount: string | null;
  priceCurrency: string | null;
}

export async function findPurchasesNearExpiry(
  db: Db,
  args: {
    now: Date;
    lookback: Date;
    statuses: Array<Purchase["status"]>;
  },
): Promise<ExpiryCandidate[]> {
  const statusClause =
    args.statuses.length === 1
      ? eq(purchases.status, args.statuses[0]!)
      : or(...args.statuses.map((s) => eq(purchases.status, s)))!;
  const rows = await db
    .select({
      id: purchases.id,
      projectId: purchases.projectId,
      subscriberId: purchases.subscriberId,
      productId: purchases.productId,
      status: purchases.status,
      store: purchases.store,
      expiresDate: purchases.expiresDate,
      gracePeriodExpires: purchases.gracePeriodExpires,
      priceAmount: purchases.priceAmount,
      priceCurrency: purchases.priceCurrency,
    })
    .from(purchases)
    .where(
      and(
        statusClause,
        lte(purchases.expiresDate, args.now),
        sql`${purchases.expiresDate} > ${args.lookback}`,
      ),
    )
    .orderBy(asc(purchases.expiresDate));
  return rows as ExpiryCandidate[];
}

/**
 * Batch lookup by ids — used by the webhook processor after it
 * claims a batch from the queue and needs the full row.
 */
export async function findPurchasesByIdsBatch(
  db: Db,
  ids: string[],
): Promise<Purchase[]> {
  if (ids.length === 0) return [];
  return db.select().from(purchases).where(inArray(purchases.id, ids));
}

// Export sql for callers that need to compose additional
// conditions on top of what the repo exposes.
export { sql };
