import { and, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  purchases,
  subscriberAccess,
  subscribers,
  type Subscriber,
} from "../schema";

// =============================================================
// Subscriber read path — Drizzle repository
// =============================================================
//
// Mirrors the Prisma call shapes currently used in
//   apps/api/src/routes/v1/config.ts           (findUnique)
//   apps/api/src/routes/dashboard/subscribers.ts (list + detail)
//
// Each function returns the same wire shape the Prisma version
// returns so a shadow read can compare them byte-for-byte. The
// idea is to route one call site at a time through the shadow
// helper, watch for divergence, and flip over to Drizzle once a
// surface has been green for long enough.
//
// Any addition here should land with a `getSubscriber…Prisma`
// counterpart in packages/db/prisma-shadow (the prisma caller
// stays the canonical reader during the hybrid window).

export interface FindByAppUserIdArgs {
  projectId: string;
  appUserId: string;
}

/**
 * Matches `prisma.subscriber.findUnique({
 *   where: { projectId_appUserId: { projectId, appUserId } },
 *   select: { attributes: true },
 * })`.
 *
 * Returns `null` when the row doesn't exist.
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
 * Matches `prisma.subscriber.findUnique({
 *   where: { projectId_appUserId: { projectId, appUserId } },
 * })` — full row. Used when the caller needs more than just
 * attributes (e.g. the transfer service reads every column).
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
 * entitlement keys. The Prisma version uses `include: { _count,
 * access: { where: … } }` which we reproduce with a LATERAL
 * subquery pattern — Postgres handles the per-row correlation
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
