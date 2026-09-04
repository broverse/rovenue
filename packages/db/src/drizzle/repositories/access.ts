import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import { store } from "../enums";
import {
  products,
  purchases,
  subscriberAccess,
  subscribers,
  type SubscriberAccessRow,
} from "../schema";

type Store = (typeof store.enumValues)[number];

// Accepts db or a Drizzle tx handle — callers inside db.transaction
// (async (tx) => …) pass `tx`.
type DbOrTx = Db;

/**
 * First subscriberAccess row matching (subscriberId, purchaseId,
 * accessId). Webhook services call this to decide whether to insert
 * a new access row or flip the existing one back to active.
 */
export async function findAccessByPurchaseAndAccessId(
  db: Db,
  subscriberId: string,
  purchaseId: string,
  accessId: string,
): Promise<SubscriberAccessRow | null> {
  const rows = await db
    .select()
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.purchaseId, purchaseId),
        eq(subscriberAccess.accessId, accessId),
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
// Access reads
// =============================================================
//
// "Live" access = active AND not past expiresDate. Either perpetual
// (null expiry) or future-dated rows qualify.

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

/** Purchase rows + accessIds from the joined product, used by
 *  syncAccess to derive the desired access set. */
export interface PurchaseWithAccessIds {
  id: string;
  status: string;
  expiresDate: Date | null;
  store: Store;
  accessIds: string[];
}

export async function findPurchasesWithAccessIds(
  db: DbOrTx,
  subscriberId: string,
): Promise<PurchaseWithAccessIds[]> {
  // Inner join on products (required — every purchase has a
  // product) so we can pull accessIds[] alongside the purchase
  // columns syncAccess reads.
  const rows = await db
    .select({
      id: purchases.id,
      status: purchases.status,
      expiresDate: purchases.expiresDate,
      store: purchases.store,
      accessIds: products.accessIds,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(eq(purchases.subscriberId, subscriberId));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    expiresDate: r.expiresDate,
    store: r.store,
    accessIds: (r.accessIds ?? []) as string[],
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
  accessId: string;
  isActive: boolean;
  expiresDate: Date | null;
  store: Store;
}

/** Insert a new access row. syncAccess inserts one per (accessId, purchase). */
export async function createAccess(
  db: DbOrTx,
  input: CreateAccessInput,
): Promise<void> {
  await db.insert(subscriberAccess).values({
    subscriberId: input.subscriberId,
    purchaseId: input.purchaseId,
    accessId: input.accessId,
    isActive: input.isActive,
    expiresDate: input.expiresDate,
    store: input.store,
  });
}

/**
 * Revoke every access row joined to a purchase chain (every
 * purchase sharing an originalTransactionId within the given
 * project). Apple-webhook uses this for refund/expire/revoke
 * transitions.
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

// =============================================================
// Entitlement drift reconciliation — worklist
// =============================================================
//
// Read by apps/api/src/workers/access-reconciliation.ts. The worklist
// lives here rather than in the worker so it stays a Drizzle query
// against the same schema every other access read uses.

export interface AccessReconciliationCandidate {
  id: string;
  projectId: string;
}

/**
 * Subscribers due an entitlement drift check: never checked (NULL sorts
 * first), or not checked within `staleBefore`. Bounded by `limit` — the
 * caller's named per-sweep constant.
 *
 * Deliberately NOT project-scoped: drift is a property of the write
 * path, not of a project, so a sweep that only ever looked at one
 * project would leave every other project unchecked.
 *
 * Soft-deleted (erased) subscribers are excluded; `mergedInto`
 * subscribers are deliberately NOT — a merged-away subscriber whose
 * purchases moved to the survivor is exactly the `orphan_row` class,
 * and deactivating their stranded access rows is the desired repair.
 *
 * Served by `subscribers_access_reconciliation_idx`, which is declared
 * NULLS FIRST to match this ORDER BY — Postgres cannot satisfy a NULLS
 * FIRST ordering from a NULLS LAST index in either scan direction.
 */
export async function selectAccessReconciliationCandidates(
  db: Db,
  args: { staleBefore: Date; limit: number },
): Promise<AccessReconciliationCandidate[]> {
  return db
    .select({ id: subscribers.id, projectId: subscribers.projectId })
    .from(subscribers)
    .where(
      and(
        // Erased subscribers are excluded. `services/gdpr/anonymize-subscriber.ts`
        // stamps `deletedAt` and RETAINS the purchases, so an erased
        // subscriber would otherwise stay a candidate forever: their
        // entitlement rows rewritten and a fresh audit row naming their
        // subscriberId written every time they went stale, indefinitely,
        // in a product that ships erasure as a feature.
        isNull(subscribers.deletedAt),
        or(
          isNull(subscribers.lastAccessReconciledAt),
          lt(subscribers.lastAccessReconciledAt, args.staleBefore),
        ),
      ),
    )
    // Raw, qualified SQL because Drizzle's `asc()` has no NULLS FIRST
    // modifier. Qualified per CLAUDE.md — a bare `${subscribers.col}`
    // renders unqualified.
    .orderBy(sql`"subscribers"."lastAccessReconciledAt" ASC NULLS FIRST`)
    .limit(args.limit);
}

/**
 * Record that the reconciler looked at these subscribers, whatever it
 * found. Stamped rows drop out of the candidate set until they go stale
 * again, so successive sweeps drain the population rather than
 * re-scanning its head.
 *
 * Takes the whole batch: a sweep stamps up to its per-run cap of rows,
 * and one statement beats that many round-trips.
 */
export async function stampAccessReconciled(
  db: DbOrTx,
  subscriberIds: string[],
  at: Date,
): Promise<void> {
  if (subscriberIds.length === 0) return;
  await db
    .update(subscribers)
    .set({ lastAccessReconciledAt: at })
    .where(inArray(subscribers.id, subscriberIds));
}
