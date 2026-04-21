import { and, count, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  experimentAssignments,
  purchases,
  subscriberAccess,
  subscribers,
  type Subscriber,
} from "../schema";

// Accepts both the top-level db and a Drizzle tx handle — the tx
// shape is the same as the db for CRUD. Callers inside
// db.transaction(async (tx) => …) pass `tx`.
type DbOrTx = Db;

/** Active (non-soft-deleted) subscriber count for a project. */
export async function countActiveSubscribers(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(subscribers)
    .where(
      and(eq(subscribers.projectId, projectId), isNull(subscribers.deletedAt)),
    );
  return Number(rows[0]?.total ?? 0);
}

// =============================================================
// Subscriber reads
// =============================================================

export interface FindByAppUserIdArgs {
  projectId: string;
  appUserId: string;
}

/**
 * Attribute-only lookup by (projectId, appUserId). Returns `null`
 * when the row doesn't exist.
 */
export async function findSubscriberAttributes(
  db: Db,
  args: FindByAppUserIdArgs,
): Promise<{ attributes: unknown } | null> {
  const rows = await db
    .select({ attributes: subscribers.attributes })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.appUserId, args.appUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Full-row lookup by (projectId, appUserId). Used when the caller
 * needs more than just attributes (e.g. the transfer service
 * reads every column).
 */
export async function findSubscriberByAppUserId(
  db: Db,
  args: FindByAppUserIdArgs,
): Promise<Subscriber | null> {
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.appUserId, args.appUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findSubscriberById(
  db: Db,
  id: string,
): Promise<Subscriber | null> {
  const rows = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Column-scoped lookup — returns just the projectId for a subscriber.
 * Used by the credit engine so ledger writes carry the correct
 * projectId without loading the entire row.
 */
export async function findSubscriberProjectId(
  db: DbOrTx,
  id: string,
): Promise<{ projectId: string } | null> {
  const rows = await db
    .select({ projectId: subscribers.projectId })
    .from(subscribers)
    .where(eq(subscribers.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateSubscriberInput {
  projectId: string;
  appUserId: string;
  attributes?: unknown;
}

/**
 * Plain INSERT (no upsert semantics). Used when the caller already
 * knows the (projectId, appUserId) pair doesn't exist, e.g. the
 * Apple webhook minting a synthetic `apple:<origTxId>` subscriber.
 */
export async function createSubscriber(
  db: DbOrTx,
  input: CreateSubscriberInput,
): Promise<Subscriber> {
  const rows = await db
    .insert(subscribers)
    .values({
      projectId: input.projectId,
      appUserId: input.appUserId,
      attributes: (input.attributes ??
        {}) as typeof subscribers.$inferInsert.attributes,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("createSubscriber: no row returned");
  return row;
}

export interface UpsertSubscriberInput {
  projectId: string;
  appUserId: string;
  /** Applied ONLY on insert. */
  createAttributes?: unknown;
  /** Applied ONLY on update. Omit for lastSeenAt-only touches. */
  updateAttributes?: unknown;
}

/**
 * Insert-or-touch a subscriber row keyed on (projectId, appUserId)
 * via `INSERT … ON CONFLICT DO UPDATE`:
 * - new row: attributes = createAttributes (defaults to {})
 * - existing: lastSeenAt = now(), attributes optionally merged
 *   when `updateAttributes` is provided.
 */
export async function upsertSubscriber(
  db: DbOrTx,
  input: UpsertSubscriberInput,
): Promise<Subscriber> {
  const now = new Date();
  const update: Partial<typeof subscribers.$inferInsert> = { lastSeenAt: now };
  if (input.updateAttributes !== undefined) {
    update.attributes =
      input.updateAttributes as typeof subscribers.$inferInsert.attributes;
  }
  const rows = await db
    .insert(subscribers)
    .values({
      projectId: input.projectId,
      appUserId: input.appUserId,
      attributes: (input.createAttributes ??
        {}) as typeof subscribers.$inferInsert.attributes,
    })
    .onConflictDoUpdate({
      target: [subscribers.projectId, subscribers.appUserId],
      set: update,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertSubscriber: no row returned");
  return row;
}

// =============================================================
// Dashboard list page
// =============================================================

export interface ListSubscribersArgs {
  projectId: string;
  /** Keyset cursor: (createdAt, id). */
  cursor?: { createdAt: Date; id: string };
  /** Page size, 1..100. The caller fetches `limit + 1` to detect
   *  the "has more" flag and trims here. */
  limit: number;
  /** Case-insensitive substring match on appUserId. */
  q?: string;
}

export interface ListedSubscriber {
  id: string;
  appUserId: string;
  attributes: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  purchaseCount: number;
  activeEntitlementKeys: string[];
}

/**
 * Dashboard list query: keyset pagination on (createdAt, id),
 * optional text search, plus per-row purchase count and active
 * entitlement keys. The aggregate fields are fetched via
 * correlated subqueries — Postgres handles the per-row correlation
 * cleanly and Drizzle's query API doesn't need a raw SQL escape
 * hatch for it.
 */
export async function listSubscribers(
  db: Db,
  args: ListSubscribersArgs,
): Promise<ListedSubscriber[]> {
  const whereClauses = [
    eq(subscribers.projectId, args.projectId),
    isNull(subscribers.deletedAt),
  ];
  if (args.q) {
    whereClauses.push(ilike(subscribers.appUserId, `%${args.q}%`));
  }
  if (args.cursor) {
    whereClauses.push(
      or(
        lt(subscribers.createdAt, args.cursor.createdAt),
        and(
          eq(subscribers.createdAt, args.cursor.createdAt),
          lt(subscribers.id, args.cursor.id),
        ),
      )!,
    );
  }

  // Correlated subqueries keep the round-trip to one SELECT. The
  // COALESCE on the entitlement array drops rows with no active
  // access down to an empty array rather than null.
  const purchaseCountSql = sql<number>`(
    SELECT COUNT(*)::int
    FROM ${purchases}
    WHERE ${purchases.subscriberId} = ${subscribers.id}
  )`;
  const entitlementsSql = sql<string[]>`(
    SELECT COALESCE(
      ARRAY_AGG(DISTINCT ${subscriberAccess.entitlementKey}),
      ARRAY[]::text[]
    )
    FROM ${subscriberAccess}
    WHERE ${subscriberAccess.subscriberId} = ${subscribers.id}
      AND ${subscriberAccess.isActive} = TRUE
      AND (${subscriberAccess.expiresDate} IS NULL
           OR ${subscriberAccess.expiresDate} > NOW())
  )`;

  const rows = await db
    .select({
      id: subscribers.id,
      appUserId: subscribers.appUserId,
      attributes: subscribers.attributes,
      firstSeenAt: subscribers.firstSeenAt,
      lastSeenAt: subscribers.lastSeenAt,
      createdAt: subscribers.createdAt,
      purchaseCount: purchaseCountSql,
      activeEntitlementKeys: entitlementsSql,
    })
    .from(subscribers)
    .where(and(...whereClauses))
    .orderBy(desc(subscribers.createdAt), desc(subscribers.id))
    .limit(args.limit);

  return rows.map((r) => ({
    ...r,
    purchaseCount: Number(r.purchaseCount) || 0,
    activeEntitlementKeys: r.activeEntitlementKeys ?? [],
  }));
}

// =============================================================
// Write paths — transfer + anonymize
// =============================================================

/**
 * Bulk-reassign every purchase row from one subscriber to another.
 * Used by the merge / transfer flow inside a Drizzle transaction.
 * Returns the number of rows updated for caller logging.
 */
export async function reassignPurchases(
  db: DbOrTx,
  fromSubscriberId: string,
  toSubscriberId: string,
): Promise<void> {
  await db
    .update(purchases)
    .set({ subscriberId: toSubscriberId })
    .where(eq(purchases.subscriberId, fromSubscriberId));
}

/**
 * Bulk-reassign every subscriber_access row from one subscriber to
 * another.
 */
export async function reassignSubscriberAccess(
  db: DbOrTx,
  fromSubscriberId: string,
  toSubscriberId: string,
): Promise<void> {
  await db
    .update(subscriberAccess)
    .set({ subscriberId: toSubscriberId })
    .where(eq(subscriberAccess.subscriberId, fromSubscriberId));
}

/**
 * Bulk-reassign every experiment_assignment row from one subscriber
 * to another.
 */
export async function reassignExperimentAssignments(
  db: DbOrTx,
  fromSubscriberId: string,
  toSubscriberId: string,
): Promise<void> {
  await db
    .update(experimentAssignments)
    .set({ subscriberId: toSubscriberId })
    .where(eq(experimentAssignments.subscriberId, fromSubscriberId));
}

/**
 * Soft-delete a subscriber and point `mergedInto` at the target. The
 * source row stays addressable for historical lookups but is
 * excluded from every "active subscriber" query by the deletedAt
 * null-check that guards them.
 */
export async function softDeleteSubscriberAsMerged(
  db: DbOrTx,
  subscriberId: string,
  mergedIntoId: string,
  deletedAt: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({ deletedAt, mergedInto: mergedIntoId })
    .where(eq(subscribers.id, subscriberId));
}

/**
 * Apply the GDPR / KVKK "right to erasure" write: replace appUserId
 * with the deterministic anonymous token, clear attributes, and
 * soft-delete.
 */
export async function anonymizeSubscriberRow(
  db: DbOrTx,
  subscriberId: string,
  anonymousId: string,
  deletedAt: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({
      appUserId: anonymousId,
      attributes: {} as typeof subscribers.$inferInsert.attributes,
      deletedAt,
    })
    .where(eq(subscribers.id, subscriberId));
}
