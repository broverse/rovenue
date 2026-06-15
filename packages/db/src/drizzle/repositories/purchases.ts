import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../client";
import { products, purchases, type Purchase } from "../schema";
import { purchaseStatus, store as storeEnum } from "../enums";

type DbOrTx = Db;
type Store = (typeof storeEnum.enumValues)[number];
type PurchaseStatus = (typeof purchaseStatus.enumValues)[number];

// =============================================================
// Purchase reads
// =============================================================

/**
 * Fetches purchases by id with the product identifier inlined.
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
 * SET …. Returns the final row (inserted or updated) via
 * .returning().
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
 * Reads the current status of a purchase by natural key, taking a
 * row lock so concurrent webhook deliveries of the same transaction
 * serialize. Returns null when the row does not yet exist (first
 * insert — no prior state to guard).
 */
export async function lockPurchaseStatusByStoreTransaction(
  db: DbOrTx,
  store: Store,
  storeTransactionId: string,
): Promise<{ id: string; status: PurchaseStatus } | null> {
  const rows = await db
    .select({ id: purchases.id, status: purchases.status })
    .from(purchases)
    .where(
      and(
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    )
    .for("update");
  return rows[0] ?? null;
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

/**
 * Terminal statuses are absorbing: once a row reaches REFUNDED or
 * REVOKED the state machine (`TRANSITIONS` in subscription-state.ts)
 * permits no outgoing edge. Mirrored here at the data layer so the
 * chain-wide updater can refuse to resurrect a terminal row.
 */
const TERMINAL_STATUSES: PurchaseStatus[] = ["REFUNDED", "REVOKED"];

export interface GuardedChainUpdateResult {
  /** ids of rows the patch was actually applied to. */
  updatedIds: string[];
  /** ids of terminal rows skipped because the patch carried `status`. */
  skippedTerminalIds: string[];
}

/**
 * Chain-wide partial update that NEVER resurrects a terminal row.
 *
 * Behaves like `updatePurchasesByOriginalTransaction`, but when the
 * patch carries a `status` field it adds a
 * `WHERE status NOT IN ('REFUNDED','REVOKED')` predicate so a
 * late / replayed non-refund notification (DID_FAIL_TO_RENEW,
 * EXPIRED, REVOKE) cannot overwrite a row the state machine treats
 * as absorbing. Returns the ids actually updated plus the ids of any
 * terminal rows that were skipped, so the caller can audit the
 * withheld transition.
 *
 * When the patch has no `status` field there is nothing to guard, so
 * every matching row is updated (no terminal rows are "skipped").
 */
export async function updateChainStatusGuarded(
  db: DbOrTx,
  projectId: string,
  originalTransactionId: string,
  patch: UpdatePurchaseFields,
): Promise<GuardedChainUpdateResult> {
  if (Object.keys(patch).length === 0) {
    return { updatedIds: [], skippedTerminalIds: [] };
  }

  const guardsStatus = "status" in patch && patch.status !== undefined;
  const chainMatch = and(
    eq(purchases.projectId, projectId),
    eq(purchases.originalTransactionId, originalTransactionId),
  );

  const updated = await db
    .update(purchases)
    .set(patch)
    .where(
      guardsStatus
        ? and(chainMatch, notInArray(purchases.status, TERMINAL_STATUSES))
        : chainMatch,
    )
    .returning({ id: purchases.id });
  const updatedIds = updated.map((r) => r.id);

  if (!guardsStatus) {
    return { updatedIds, skippedTerminalIds: [] };
  }

  // Surface the terminal rows that were left untouched so the caller
  // can record a `subscription.transition_rejected` audit entry.
  const skipped = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(chainMatch, inArray(purchases.status, TERMINAL_STATUSES)));

  return { updatedIds, skippedTerminalIds: skipped.map((r) => r.id) };
}

/**
 * Partial update keyed on (store, storeTransactionId). Both
 * Stripe's invoice.payment_failed and Google's voided-purchase
 * paths need to transition a row without first looking it up by
 * id.
 */
export async function updatePurchaseByStoreTransaction(
  db: DbOrTx,
  store: Store,
  storeTransactionId: string,
  patch: UpdatePurchaseFields,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db
    .update(purchases)
    .set(patch)
    .where(
      and(
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    );
}

/**
 * Compare-and-swap status flip for the expiry worker.
 * `WHERE id = $1 AND status = $2` ensures two concurrent workers
 * can't both transition the same row — the second one sees 0 rows
 * updated and skips. Returns the count of rows actually updated.
 */
export async function updatePurchaseStatusIf(
  db: DbOrTx,
  id: string,
  expectedStatus: PurchaseStatus,
  newStatus: PurchaseStatus,
): Promise<number> {
  const result = await db
    .update(purchases)
    .set({ status: newStatus })
    .where(
      and(eq(purchases.id, id), eq(purchases.status, expectedStatus)),
    )
    .returning({ id: purchases.id });
  return result.length;
}
