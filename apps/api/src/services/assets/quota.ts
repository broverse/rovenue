import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, type Db } from "@rovenue/db";
import { quotasUnlimited } from "../../lib/host-mode";

// =============================================================
// Storage quota — checked and reserved in one statement
// =============================================================
//
// A read-then-write check is a TOCTOU race: two concurrent uploads both
// read a figure under the cap and both proceed. Fonts wave E1
// documented and accepted exactly that race for its family lookup,
// where the loser was one bad row. Here the loser is unbounded
// overshoot of a paid limit, so the check and the reservation happen in
// the same conditional INSERT, itself wrapped in a per-project advisory
// xact lock (see reserveStorage) so two concurrent transactions cannot
// each observe the same pre-insert sum under READ COMMITTED.
//
// Usage is derived from the live asset rows rather than kept in a
// separate counter column, so it cannot drift from what actually
// exists. The WHERE clause re-evaluates the sum (assets + open
// reservations) at write time, under the lock reserveStorage takes.
//
// HOST_MODE=self has no billing, so it has no cap.

export interface StorageUsage {
  usedBytes: number;
  /** null means unlimited. */
  limitBytes: number | null;
}

/** Namespaces the advisory-lock key space so a project id can never
 *  collide with a lock key some other subsystem derives from the same
 *  string (e.g. paywalls.ts locks publishes by paywall id). */
const QUOTA_LOCK_PREFIX = "paywall-asset-quota:";

/**
 * `billing_tier_limits` is keyed by (tier, cycle), so a bare
 * `tier = 'free'` lookup with no cycle predicate is ambiguous between
 * the monthly and annual rows and Postgres picks one arbitrarily under
 * `LIMIT 1`. A project with no subscription row has no cycle of its
 * own to join on, so the free-tier fallback must pick one explicitly.
 * Matches `billingSubscriptions.cycle`'s own default.
 */
const FALLBACK_CYCLE = "monthly";

interface TierLimitRow {
  limit_bytes: string | null;
}

async function tierLimitBytes(db: Db, projectId: string): Promise<number | null> {
  if (quotasUnlimited()) return null;

  const rows = await db.execute(sql`
    SELECT "billing_tier_limits"."asset_storage_bytes_limit" AS limit_bytes
    FROM "billing_subscriptions"
    JOIN "billing_tier_limits"
      ON "billing_tier_limits"."tier" = "billing_subscriptions"."tier"
     AND "billing_tier_limits"."cycle" = "billing_subscriptions"."cycle"
    WHERE "billing_subscriptions"."project_id" = ${projectId}
      AND "billing_subscriptions"."state" != 'deleted'
    LIMIT 1
  `);
  const row = (rows as unknown as { rows: TierLimitRow[] }).rows[0];
  // No subscription row must NOT mean unlimited — that fails OPEN on a
  // paid limit, and every project starts life without one. Fall back to
  // the free tier's cap, which is what such a project is entitled to.
  if (!row) return freeTierLimitBytes(db);
  if (row.limit_bytes === null) return null; // enterprise: genuinely unlimited
  return Number(row.limit_bytes);
}

async function freeTierLimitBytes(db: Db): Promise<number | null> {
  const rows = await db.execute(sql`
    SELECT "billing_tier_limits"."asset_storage_bytes_limit" AS limit_bytes
    FROM "billing_tier_limits"
    WHERE "billing_tier_limits"."tier" = 'free'
      AND "billing_tier_limits"."cycle" = ${FALLBACK_CYCLE}
    LIMIT 1
  `);
  const row = (rows as unknown as { rows: TierLimitRow[] }).rows[0];
  if (!row || row.limit_bytes === null) return null;
  return Number(row.limit_bytes);
}

async function usedBytes(db: Db, projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM("paywall_assets"."byteSize"), 0) AS used
    FROM "paywall_assets"
    WHERE "paywall_assets"."projectId" = ${projectId}
      AND "paywall_assets"."deletedAt" IS NULL
  `);
  const row = (rows as unknown as { rows: { used: string }[] }).rows[0];
  return Number(row?.used ?? 0);
}

export async function getStorageUsage(
  db: Db,
  projectId: string,
): Promise<StorageUsage> {
  const [used, limit] = await Promise.all([
    usedBytes(db, projectId),
    tierLimitBytes(db, projectId),
  ]);
  return { usedBytes: used, limitBytes: limit };
}

/** Sentinel for an unlimited project, where no row was inserted and so
 *  there is nothing to release. `releaseReservation` ignores it. */
export const UNLIMITED_RESERVATION = "unlimited";

/**
 * Reserve `bytes` against the project's cap. Returns the reservation id,
 * `UNLIMITED_RESERVATION` for an unlimited project, or null if the
 * reservation would exceed the cap.
 *
 * The reservation is a row in `paywall_asset_reservations` inserted
 * only when the live total (committed assets + other open
 * reservations) plus this request still fits. The INSERT ... SELECT ...
 * WHERE alone is not enough under READ COMMITTED: two concurrent
 * transactions can each take their own snapshot of the sum before
 * either commits, and both pass. A per-project `pg_advisory_xact_lock`
 * held for the duration of this transaction serialises reservations for
 * the same project, so the second transaction's snapshot is only taken
 * after the first has committed (or rolled back) and released the lock.
 *
 * The caller commits the real asset row in the same transaction and
 * releases the reservation there; an upload that dies before committing
 * leaves a reservation the sweeper clears alongside its orphaned
 * object.
 */
export async function reserveStorage(
  db: Db,
  projectId: string,
  bytes: number,
): Promise<string | null> {
  const limit = await tierLimitBytes(db, projectId);
  if (limit === null) return UNLIMITED_RESERVATION;

  return db.transaction(async (tx) => {
    await drizzle.lockRepo.advisoryXactLock(tx, `${QUOTA_LOCK_PREFIX}${projectId}`);

    const result = await tx.execute(sql`
      INSERT INTO "paywall_asset_reservations" ("id", "projectId", "bytes", "createdAt")
      SELECT ${createId()}, ${projectId}, ${bytes}, now()
      WHERE (
        COALESCE((
          SELECT SUM("paywall_assets"."byteSize") FROM "paywall_assets"
          WHERE "paywall_assets"."projectId" = ${projectId}
            AND "paywall_assets"."deletedAt" IS NULL
        ), 0)
        + COALESCE((
          SELECT SUM("paywall_asset_reservations"."bytes")
          FROM "paywall_asset_reservations"
          WHERE "paywall_asset_reservations"."projectId" = ${projectId}
        ), 0)
        + ${bytes}
      ) <= ${limit}
      RETURNING "id"
    `);
    const row = (result as unknown as { rows: { id: string }[] }).rows[0];
    return row?.id ?? null;
  });
}

/**
 * Release a reservation once its asset row is committed. MUST run in
 * the same transaction as the row insert: a reservation that outlives
 * its upload holds the bytes against the cap TWICE — once as the
 * reservation, once as the committed row — until the sweeper clears it
 * hours later.
 */
export async function releaseReservation(db: Db, id: string): Promise<void> {
  if (id === UNLIMITED_RESERVATION) return;
  await db.execute(sql`
    DELETE FROM "paywall_asset_reservations"
    WHERE "paywall_asset_reservations"."id" = ${id}
  `);
}
