import { and, count, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
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

export interface FindByRovenueIdForAttributesArgs {
  projectId: string;
  rovenueId: string;
}

/**
 * Attribute-only lookup by (projectId, rovenueId). Returns `null`
 * when the row doesn't exist. Used by the /v1/config route to read
 * existing attributes before the upsert so they can be merged
 * rather than overwritten.
 */
export async function findSubscriberAttributesByRovenueId(
  db: Db,
  args: FindByRovenueIdForAttributesArgs,
): Promise<{ attributes: unknown } | null> {
  const rows = await db
    .select({ attributes: subscribers.attributes })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.rovenueId, args.rovenueId),
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

export interface FindByRovenueIdArgs {
  projectId: string;
  rovenueId: string;
}

/** Full-row lookup by (projectId, rovenueId). The primary device key. */
export async function findSubscriberByRovenueId(
  db: Db,
  args: FindByRovenueIdArgs,
): Promise<Subscriber | null> {
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.rovenueId, args.rovenueId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ResolveKeyArgs {
  projectId: string;
  /** The id the SDK sent — a rovenueId, or a legacy appUserId mid-migration. */
  key: string;
}

/**
 * Request→subscriber resolution for the rovenueId era:
 *  1. match by rovenueId; if the row is soft-deleted with a mergedInto
 *     target, follow the redirect to the canonical row;
 *  2. else fall back to a legacy active appUserId match (dual-read window).
 * Returns null when nothing resolves.
 */
export async function resolveSubscriberByRovenueIdOrLegacy(
  db: Db,
  args: ResolveKeyArgs,
): Promise<Subscriber | null> {
  const byRovenue = await findSubscriberByRovenueId(db, {
    projectId: args.projectId,
    rovenueId: args.key,
  });
  if (byRovenue) {
    if (!byRovenue.deletedAt) return byRovenue;
    // Soft-deleted: follow the mergedInto chain to the live canonical
    // row. A multi-hop chain (A→B→C) can occur when an already-merged
    // row is itself merged again, and an intermediate hop may be
    // soft-deleted too — so loop while the cursor is dead and points
    // onward. A depth cap guards against an accidental cycle.
    let cursor = byRovenue;
    for (let i = 0; i < 5 && cursor.deletedAt && cursor.mergedInto; i++) {
      const next = await findSubscriberById(db, cursor.mergedInto);
      if (!next) return null;
      cursor = next;
    }
    return cursor.deletedAt ? null : cursor;
  }
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, args.projectId),
        eq(subscribers.appUserId, args.key),
        isNull(subscribers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Attach (or change) the customer label on a subscriber row. */
export async function setAppUserId(
  db: DbOrTx,
  id: string,
  appUserId: string,
  identifiedAt: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({ appUserId, identifiedAt, updatedAt: new Date() })
    .where(eq(subscribers.id, id));
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
 * Lookup by (projectId, appleAppAccountToken). Used by the Refund
 * Shield CONSUMPTION_REQUEST handler to resolve the owning subscriber
 * from the JWS `appAccountToken` field without needing the original
 * transaction id. Returns `null` when no row matches — callers fall
 * back to a purchases.original_transaction_id join.
 */
export async function findSubscriberByAppleAppAccountToken(
  db: Db,
  projectId: string,
  appleAppAccountToken: string,
): Promise<Subscriber | null> {
  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        eq(subscribers.projectId, projectId),
        eq(subscribers.appleAppAccountToken, appleAppAccountToken),
      ),
    )
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
  rovenueId: string;
  appUserId?: string | null;
  attributes?: unknown;
}

/**
 * Plain INSERT (no upsert semantics). Used when the caller already
 * knows the (projectId, rovenueId) pair doesn't exist, e.g. the
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
      rovenueId: input.rovenueId,
      appUserId: input.appUserId ?? null,
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
  rovenueId: string;
  appUserId?: string | null;
  /** Applied ONLY on insert. */
  createAttributes?: unknown;
  /** Applied ONLY on update. Omit for lastSeenAt-only touches. */
  updateAttributes?: unknown;
  /**
   * Apple StoreKit `appAccountToken` (UUID) attached to the purchase.
   * On insert this is written verbatim. On update it is COALESCEd so
   * an existing token is never clobbered by a later notification that
   * happens to lack the field — Refund Shield depends on this column
   * to look up the owning subscriber from CONSUMPTION_REQUEST.
   */
  appleAppAccountToken?: string | null;
}

/**
 * Insert-or-touch a subscriber row keyed on (projectId, rovenueId)
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
  // Only overwrite the existing column when the caller actually has a
  // token. Apple notifications without `appAccountToken` (e.g. legacy
  // purchases or non-token-binding flows) must not erase a previously
  // captured token — COALESCE keeps the old value in that case.
  if (input.appleAppAccountToken != null) {
    update.appleAppAccountToken = input.appleAppAccountToken;
  }
  const rows = await db
    .insert(subscribers)
    .values({
      projectId: input.projectId,
      rovenueId: input.rovenueId,
      appUserId: input.appUserId ?? null,
      attributes: (input.createAttributes ??
        {}) as typeof subscribers.$inferInsert.attributes,
      appleAppAccountToken: input.appleAppAccountToken ?? null,
    })
    .onConflictDoUpdate({
      target: [subscribers.projectId, subscribers.rovenueId],
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

export type SubscriberStatusFilter = "active" | "trial" | "grace" | "churned";
export type SubscriberPlatformFilter = "ios" | "android" | "web";
/** Sort key + implicit direction:
 *  - `last_activity`  — `lastSeenAt DESC` (default)
 *  - `created`        — `createdAt DESC`
 *  - `ltv`            — sum of `purchases.priceAmount` DESC
 *  - `purchases`      — count of `purchases` DESC
 *  Every mode tiebreaks on `id DESC` so the keyset stays unique. */
export type SubscriberSortMode =
  | "last_activity"
  | "created"
  | "ltv"
  | "purchases";

/** Friendly platform alias → on-disk `Store` enum variant. */
const PLATFORM_TO_STORE: Record<SubscriberPlatformFilter, string> = {
  ios: "APP_STORE",
  android: "PLAY_STORE",
  web: "STRIPE",
};

export interface ListSubscribersArgs {
  projectId: string;
  /** Keyset cursor: (sortValue, id) — `sortValue` is interpreted
   *  according to `sort`. ISO timestamp for date sorts, decimal
   *  string for ltv, integer string for purchases. */
  cursor?: { value: string; id: string };
  /** Defaults to `last_activity` when omitted. */
  sort?: SubscriberSortMode;
  /** Page size, 1..100. The caller fetches `limit + 1` to detect
   *  the "has more" flag and trims here. */
  limit: number;
  /** Case-insensitive substring match on appUserId. */
  q?: string;
  /** Derived lifecycle status — matches the dashboard scope tabs. */
  status?: SubscriberStatusFilter;
  /** Subscriber must have an *active* access with this id. */
  accessId?: string;
  /** Subscriber must have at least one purchase from this platform. */
  platforms?: ReadonlyArray<SubscriberPlatformFilter>;
  /** Match on `attributes->>'country'` (exact, case-insensitive). */
  country?: string;
  /** Sum of purchase priceAmount across the subscriber ≥ ltvMin (USD-as-is). */
  ltvMin?: number;
  /** Inclusive lower bound on `lastSeenAt`. */
  lastSeenFrom?: Date;
  /** Inclusive upper bound on `lastSeenAt`. */
  lastSeenTo?: Date;
}

export interface ListedSubscriber {
  id: string;
  appUserId: string | null;
  attributes: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  purchaseCount: number;
  activeAccessIds: string[];
  /** Lifetime gross from `purchases.priceAmount`, decimal-as-string. */
  ltvUsd: string;
  /** Distinct platforms across all purchases (ios/android/web). */
  platforms: SubscriberPlatformFilter[];
  /** Cursor boundary value for the page this row appeared on —
   *  format matches `sort`. ISO timestamp for date sorts, decimal
   *  string for ltv, integer string for purchases. */
  sortValue: string;
}

const STORE_TO_PLATFORM: Record<string, SubscriberPlatformFilter> = {
  APP_STORE: "ios",
  PLAY_STORE: "android",
  STRIPE: "web",
};

/**
 * Dashboard list query: keyset pagination on (createdAt, id),
 * optional text search + structured filters (status / access /
 * platform / country / ltvMin), plus per-row purchase count, LTV,
 * platforms, and active access ids. Aggregate fields are fetched
 * via correlated subqueries — Postgres handles the per-row
 * correlation cleanly and Drizzle's query API doesn't need a raw
 * SQL escape hatch for it.
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
    // appUserId is null for SDK-only subscribers, which makes an
    // appUserId-only ILIKE evaluate to NULL (excluded). OR in the
    // rovenueId column so those rows stay searchable.
    whereClauses.push(
      or(
        ilike(subscribers.appUserId, `%${args.q}%`),
        ilike(subscribers.rovenueId, `%${args.q}%`),
      )!,
    );
  }

  // --- status (derived from access + purchase rows) -----------
  if (args.status === "active") {
    whereClauses.push(sql`EXISTS (
      SELECT 1 FROM ${subscriberAccess}
      WHERE ${subscriberAccess.subscriberId} = ${subscribers.id}
        AND ${subscriberAccess.isActive} = TRUE
        AND (${subscriberAccess.expiresDate} IS NULL
             OR ${subscriberAccess.expiresDate} > NOW())
    )`);
  } else if (args.status === "trial") {
    whereClauses.push(sql`EXISTS (
      SELECT 1 FROM ${purchases}
      WHERE ${purchases.subscriberId} = ${subscribers.id}
        AND ${purchases.status} = 'TRIAL'
        AND (${purchases.expiresDate} IS NULL
             OR ${purchases.expiresDate} > NOW())
    )`);
  } else if (args.status === "grace") {
    whereClauses.push(sql`EXISTS (
      SELECT 1 FROM ${purchases}
      WHERE ${purchases.subscriberId} = ${subscribers.id}
        AND ${purchases.status} = 'GRACE_PERIOD'
        AND (${purchases.gracePeriodExpires} IS NULL
             OR ${purchases.gracePeriodExpires} > NOW())
    )`);
  } else if (args.status === "churned") {
    // No live access today but has had at least one purchase (so
    // greenfield subscribers don't bleed into the "churned" tab).
    whereClauses.push(sql`NOT EXISTS (
      SELECT 1 FROM ${subscriberAccess}
      WHERE ${subscriberAccess.subscriberId} = ${subscribers.id}
        AND ${subscriberAccess.isActive} = TRUE
        AND (${subscriberAccess.expiresDate} IS NULL
             OR ${subscriberAccess.expiresDate} > NOW())
    )`);
    whereClauses.push(sql`EXISTS (
      SELECT 1 FROM ${purchases}
      WHERE ${purchases.subscriberId} = ${subscribers.id}
    )`);
  }

  // --- access id (must be currently active) --------------------
  if (args.accessId) {
    whereClauses.push(sql`EXISTS (
      SELECT 1 FROM ${subscriberAccess}
      WHERE ${subscriberAccess.subscriberId} = ${subscribers.id}
        AND ${subscriberAccess.accessId} = ${args.accessId}
        AND ${subscriberAccess.isActive} = TRUE
        AND (${subscriberAccess.expiresDate} IS NULL
             OR ${subscriberAccess.expiresDate} > NOW())
    )`);
  }

  // --- platform (any-of) --------------------------------------
  if (args.platforms && args.platforms.length > 0) {
    const stores = args.platforms.map((p) => PLATFORM_TO_STORE[p]);
    whereClauses.push(sql`EXISTS (
      SELECT 1 FROM ${purchases}
      WHERE ${purchases.subscriberId} = ${subscribers.id}
        AND ${purchases.store}::text = ANY(${stores})
    )`);
  }

  // --- country (attributes JSON) ------------------------------
  if (args.country) {
    whereClauses.push(
      sql`UPPER(${subscribers.attributes}->>'country') = ${args.country.toUpperCase()}`,
    );
  }

  // --- ltv minimum (sum of purchase prices) -------------------
  if (typeof args.ltvMin === "number" && Number.isFinite(args.ltvMin)) {
    whereClauses.push(sql`(
      SELECT COALESCE(SUM(${purchases.priceAmount}), 0)
      FROM ${purchases}
      WHERE ${purchases.subscriberId} = ${subscribers.id}
    ) >= ${args.ltvMin}`);
  }

  // --- lastSeenAt range (inclusive) ---------------------------
  if (args.lastSeenFrom) {
    whereClauses.push(gte(subscribers.lastSeenAt, args.lastSeenFrom));
  }
  if (args.lastSeenTo) {
    whereClauses.push(lte(subscribers.lastSeenAt, args.lastSeenTo));
  }

  // Correlated subqueries keep the round-trip to one SELECT. The
  // COALESCE on the entitlement array drops rows with no active
  // access down to an empty array rather than null. The LTV +
  // purchase-count expressions are reused both as SELECT columns
  // and (when the matching sort mode is active) as the ORDER BY
  // expression + keyset boundary.
  const purchaseCountExpr = sql<number>`(
    SELECT COUNT(*)::int
    FROM ${purchases}
    WHERE ${purchases.subscriberId} = ${subscribers.id}
  )`;
  const ltvExpr = sql<string>`(
    SELECT COALESCE(SUM(${purchases.priceAmount}), 0)
    FROM ${purchases}
    WHERE ${purchases.subscriberId} = ${subscribers.id}
  )`;

  // Sort + keyset construction. `sortExpr` is the column / expression
  // the ORDER BY tiebreaks on (id is always the secondary key). When a
  // cursor is present, we WHERE the same expression on the (value, id)
  // boundary so the next page starts strictly after it.
  const sortMode: SubscriberSortMode = args.sort ?? "last_activity";
  let sortExpr: ReturnType<typeof sql>;
  let castedCursorValue: ReturnType<typeof sql> | null = null;
  switch (sortMode) {
    case "last_activity":
      sortExpr = sql`${subscribers.lastSeenAt}`;
      if (args.cursor) {
        castedCursorValue = sql`${args.cursor.value}::timestamptz`;
      }
      break;
    case "created":
      sortExpr = sql`${subscribers.createdAt}`;
      if (args.cursor) {
        castedCursorValue = sql`${args.cursor.value}::timestamptz`;
      }
      break;
    case "ltv":
      sortExpr = ltvExpr;
      if (args.cursor) {
        castedCursorValue = sql`${args.cursor.value}::numeric`;
      }
      break;
    case "purchases":
      sortExpr = purchaseCountExpr;
      if (args.cursor) {
        castedCursorValue = sql`${args.cursor.value}::int`;
      }
      break;
  }

  if (args.cursor && castedCursorValue) {
    whereClauses.push(sql`(
      ${sortExpr} < ${castedCursorValue}
      OR (${sortExpr} = ${castedCursorValue} AND ${subscribers.id} < ${args.cursor.id})
    )`);
  }

  const accessIdsSql = sql<string[]>`(
    SELECT COALESCE(
      ARRAY_AGG(DISTINCT ${subscriberAccess.accessId}),
      ARRAY[]::text[]
    )
    FROM ${subscriberAccess}
    WHERE ${subscriberAccess.subscriberId} = ${subscribers.id}
      AND ${subscriberAccess.isActive} = TRUE
      AND (${subscriberAccess.expiresDate} IS NULL
           OR ${subscriberAccess.expiresDate} > NOW())
  )`;
  // Reuse the same correlated subquery defined above for ltvExpr,
  // but cast to text so the value round-trips through the wire
  // unambiguously.
  const ltvSql = sql<string>`(${ltvExpr})::text`;
  const platformsSql = sql<string[]>`(
    SELECT COALESCE(
      ARRAY_AGG(DISTINCT ${purchases.store}::text),
      ARRAY[]::text[]
    )
    FROM ${purchases}
    WHERE ${purchases.subscriberId} = ${subscribers.id}
  )`;
  // Surface the sort boundary as a string the route can re-encode
  // into the next cursor without re-deriving it. Timestamps come
  // through as ISO strings; numerics as plain decimal strings.
  const sortValueSql = sql<string>`(${sortExpr})::text`;

  const rows = await db
    .select({
      id: subscribers.id,
      appUserId: subscribers.appUserId,
      attributes: subscribers.attributes,
      firstSeenAt: subscribers.firstSeenAt,
      lastSeenAt: subscribers.lastSeenAt,
      createdAt: subscribers.createdAt,
      purchaseCount: purchaseCountExpr,
      activeAccessIds: accessIdsSql,
      ltvUsd: ltvSql,
      platforms: platformsSql,
      sortValue: sortValueSql,
    })
    .from(subscribers)
    .where(and(...whereClauses))
    .orderBy(sql`${sortExpr} DESC`, desc(subscribers.id))
    .limit(args.limit);

  return rows.map((r) => ({
    ...r,
    purchaseCount: Number(r.purchaseCount) || 0,
    activeAccessIds: r.activeAccessIds ?? [],
    ltvUsd: typeof r.ltvUsd === "string" ? r.ltvUsd : "0",
    platforms: (r.platforms ?? [])
      .map((s) => STORE_TO_PLATFORM[s])
      .filter((p): p is SubscriberPlatformFilter => Boolean(p)),
    sortValue: typeof r.sortValue === "string" ? r.sortValue : "",
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
