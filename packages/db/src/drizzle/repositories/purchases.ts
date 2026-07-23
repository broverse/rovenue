import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { products, purchases, type Purchase } from "../schema";
import { purchaseStatus, store as storeEnum } from "../enums";

// A repository helper accepts either the singleton `Db` or a Drizzle
// transaction handle. Both share the same query-builder surface, so a
// plain `Db` alias is the project-wide convention (see projects.ts,
// subscribers.ts). Threading a tx in lets the `FOR UPDATE` read in
// `lockPurchaseStatusByStoreTransaction` and the subsequent guarded
// write run inside one transaction so the row lock is actually held
// across the read-decide-write (FINDING 1, mechanism (a)).
type DbOrTx = Db;
type Store = (typeof storeEnum.enumValues)[number];
type PurchaseStatus = (typeof purchaseStatus.enumValues)[number];

/**
 * Terminal statuses are absorbing: once a row reaches REFUNDED or
 * REVOKED the state machine (`TRANSITIONS` in subscription-state.ts)
 * permits no outgoing edge. Mirrored here at the data layer so every
 * status write can refuse to resurrect a terminal row even when the
 * caller's read-decide-write was not perfectly serialized.
 */
const TERMINAL_STATUSES: PurchaseStatus[] = ["REFUNDED", "REVOKED"];

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
 *
 * Terminal-resurrection backstop (FINDING 1, mechanism (b)): when the
 * `update` patch carries a `status`, the ON CONFLICT branch only
 * applies it when the EXISTING row is non-terminal — implemented as
 * `status = CASE WHEN purchases.status IN ('REFUNDED','REVOKED')
 * THEN purchases.status ELSE <new status> END`. Non-status fields
 * (expiry, price, verifiedAt) still update unconditionally, and the
 * first-insert (no conflict) path is unaffected. This makes a
 * REFUNDED/REVOKED row impossible to resurrect to ACTIVE via the
 * upsert even if two distinct events for the same transaction
 * interleave outside a serializing transaction. Pass
 * `guardTerminalStatus: false` only for paths that legitimately need
 * to overwrite a terminal status (none today).
 */
export async function upsertPurchase(
  db: DbOrTx,
  args: {
    store: Store;
    storeTransactionId: string;
    create: NewPurchaseFields;
    update: UpdatePurchaseFields;
    guardTerminalStatus?: boolean;
  },
): Promise<Purchase> {
  const guardTerminalStatus = args.guardTerminalStatus ?? true;
  let set: Record<string, unknown> = args.update;

  if (
    guardTerminalStatus &&
    "status" in args.update &&
    args.update.status !== undefined
  ) {
    set = {
      ...args.update,
      // Only advance `status` when the conflicting row is non-terminal.
      status: sql`CASE WHEN ${purchases.status} IN ('REFUNDED', 'REVOKED') THEN ${purchases.status} ELSE ${args.update.status} END`,
    };
  }

  const rows = await db
    .insert(purchases)
    .values(args.create)
    .onConflictDoUpdate({
      target: [purchases.store, purchases.storeTransactionId],
      set,
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
 *
 * Terminal-resurrection backstop (FINDING 1, mechanism (b)): like
 * `upsertPurchase`, when the patch carries a `status` it is wrapped in
 * a `CASE WHEN purchases.status IN ('REFUNDED','REVOKED') THEN
 * purchases.status ELSE <new status> END` so a terminal row's status
 * is never overwritten, while non-status fields (refundDate,
 * cancellationDate, …) still apply unconditionally. Pass
 * `guardTerminalStatus: false` to opt out (none today).
 */
export async function updatePurchase(
  db: DbOrTx,
  id: string,
  patch: UpdatePurchaseFields,
  opts?: { guardTerminalStatus?: boolean },
): Promise<Purchase | null> {
  if (Object.keys(patch).length === 0) return null;
  const guardTerminalStatus = opts?.guardTerminalStatus ?? true;
  let set: Record<string, unknown> = patch;
  if (guardTerminalStatus && "status" in patch && patch.status !== undefined) {
    set = {
      ...patch,
      status: sql`CASE WHEN ${purchases.status} IN ('REFUNDED', 'REVOKED') THEN ${purchases.status} ELSE ${patch.status} END`,
    };
  }
  const rows = await db
    .update(purchases)
    .set(set)
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

/**
 * The Stripe subscription ids a subscriber still has live access through.
 * Used by GDPR erasure to cancel a forgotten customer's funnel
 * subscriptions so they are not billed further. Only recurring
 * subscriptions (`sub_…`) are returned — a one-time purchase's
 * storeTransactionId is a PaymentIntent, already captured and nothing to
 * cancel. Status is restricted to the access-granting set so an already
 * -ended subscription is not re-touched.
 */
export async function findActiveStripeSubscriptionIds(
  db: Db,
  subscriberId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ storeTransactionId: purchases.storeTransactionId })
    .from(purchases)
    .where(
      and(
        eq(purchases.subscriberId, subscriberId),
        eq(purchases.store, "STRIPE"),
        inArray(purchases.status, ["ACTIVE", "TRIAL", "GRACE_PERIOD"]),
        sql`${purchases.storeTransactionId} LIKE 'sub_%'`,
      ),
    );
  return rows.map((r) => r.storeTransactionId);
}
