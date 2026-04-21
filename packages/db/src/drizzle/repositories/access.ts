import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../client";
import { store } from "../enums";
import {
  products,
  purchases,
  subscriberAccess,
  type SubscriberAccessRow,
} from "../schema";

type Store = (typeof store.enumValues)[number];

// Accepts db or a Drizzle tx handle — callers inside db.transaction
// (async (tx) => …) pass `tx`.
type DbOrTx = Db;

/**
 * First subscriberAccess row matching (subscriberId, purchaseId,
 * entitlementKey). Webhook services call this to decide whether
 * to insert a new access row or flip the existing one back to
 * active.
 */
export async function findAccessByPurchaseAndKey(
  db: Db,
  subscriberId: string,
  purchaseId: string,
  entitlementKey: string,
): Promise<SubscriberAccessRow | null> {
  const rows = await db
    .select()
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.purchaseId, purchaseId),
        eq(subscriberAccess.entitlementKey, entitlementKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * IDs of subscriber_access rows joined on a purchase chain —
 * "every access row whose purchase has this originalTransactionId
 * within the given project". Used by apple-webhook to revoke
 * access when a transaction chain expires or refunds.
 */
export async function findAccessIdsForPurchaseChain(
  db: Db,
  projectId: string,
  originalTransactionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: subscriberAccess.id })
    .from(subscriberAccess)
    .innerJoin(purchases, eq(purchases.id, subscriberAccess.purchaseId))
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.originalTransactionId, originalTransactionId),
      ),
    );
  return rows.map((r) => r.id);
}

// Re-export for callers that compose IN () clauses on top.
export { inArray };

// =============================================================
// Entitlement access reads — Drizzle repository
// =============================================================
//
// Mirrors prisma.subscriberAccess.findMany({ where: { subscriberId,
// isActive: true, OR: [{ expiresDate: null }, { expiresDate: { gt } }]
// } }) used by apps/api/src/services/access-engine.ts. The
// non-expired + active filter defines "live" entitlement: either
// perpetual (null expiry) or not yet past expiresDate.

export async function findActiveAccess(
  db: Db,
  subscriberId: string,
  now: Date = new Date(),
): Promise<SubscriberAccessRow[]> {
  return db
    .select()
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.isActive, true),
        or(
          isNull(subscriberAccess.expiresDate),
          gt(subscriberAccess.expiresDate, now),
        )!,
      ),
    );
}

// =============================================================
// Access reconciliation — writes
// =============================================================

/** Every access row for a subscriber (active + inactive). Used by
 *  syncAccess to reconcile against the authoritative purchase set. */
export async function findAllAccessBySubscriber(
  db: DbOrTx,
  subscriberId: string,
): Promise<SubscriberAccessRow[]> {
  return db
    .select()
    .from(subscriberAccess)
    .where(eq(subscriberAccess.subscriberId, subscriberId));
}

/** Purchase rows + entitlementKeys from the joined product, used by
 *  syncAccess to derive the desired entitlement set. */
export interface PurchaseWithEntitlementKeys {
  id: string;
  status: string;
  expiresDate: Date | null;
  store: Store;
  entitlementKeys: string[];
}

export async function findPurchasesWithEntitlementKeys(
  db: DbOrTx,
  subscriberId: string,
): Promise<PurchaseWithEntitlementKeys[]> {
  // Inner join on products (required — every purchase has a
  // product) so we can pull entitlementKeys[] alongside the
  // purchase columns syncAccess reads.
  const rows = await db
    .select({
      id: purchases.id,
      status: purchases.status,
      expiresDate: purchases.expiresDate,
      store: purchases.store,
      entitlementKeys: products.entitlementKeys,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(eq(purchases.subscriberId, subscriberId));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    expiresDate: r.expiresDate,
    store: r.store,
    entitlementKeys: (r.entitlementKeys ?? []) as string[],
  }));
}

/** Flip an access row's `isActive` flag (expiry untouched). */
export async function setAccessActive(
  db: DbOrTx,
  id: string,
  isActive: boolean,
): Promise<void> {
  await db
    .update(subscriberAccess)
    .set({ isActive })
    .where(eq(subscriberAccess.id, id));
}

/** Flip `isActive` and reset `expiresDate` at the same time. */
export async function setAccessActiveAndExpiry(
  db: DbOrTx,
  id: string,
  isActive: boolean,
  expiresDate: Date | null,
): Promise<void> {
  await db
    .update(subscriberAccess)
    .set({ isActive, expiresDate })
    .where(eq(subscriberAccess.id, id));
}

export interface CreateAccessInput {
  subscriberId: string;
  purchaseId: string;
  entitlementKey: string;
  isActive: boolean;
  expiresDate: Date | null;
  store: Store;
}

/** Insert a new access row. syncAccess inserts one per (key, purchase). */
export async function createAccess(
  db: DbOrTx,
  input: CreateAccessInput,
): Promise<void> {
  await db.insert(subscriberAccess).values({
    subscriberId: input.subscriberId,
    purchaseId: input.purchaseId,
    entitlementKey: input.entitlementKey,
    isActive: input.isActive,
    expiresDate: input.expiresDate,
    store: input.store,
  });
}

/**
 * Revoke every access row joined to a purchase chain (every purchase
 * that shares an originalTransactionId within the given project).
 * Apple-webhook uses this for refund/expire/revoke transitions.
 * Equivalent to Prisma's nested relational filter:
 *   { where: { purchase: { projectId, originalTransactionId } } }
 */
export async function revokeAccessByOriginalTransaction(
  db: DbOrTx,
  projectId: string,
  originalTransactionId: string,
): Promise<void> {
  const ids = await findAccessIdsForPurchaseChain(
    db,
    projectId,
    originalTransactionId,
  );
  if (ids.length === 0) return;
  await db
    .update(subscriberAccess)
    .set({ isActive: false })
    .where(inArray(subscriberAccess.id, ids));
}

/**
 * Flip every access row for a single purchase to isActive=false.
 * Used by the Google webhook when a subscription transitions into a
 * non-entitlement state (cancelled, held, expired).
 */
export async function revokeAccessByPurchaseId(
  db: DbOrTx,
  purchaseId: string,
): Promise<void> {
  await db
    .update(subscriberAccess)
    .set({ isActive: false })
    .where(eq(subscriberAccess.purchaseId, purchaseId));
}
