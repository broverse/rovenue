import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  RECONCILABLE_STATUSES,
  TERMINAL_STATUSES,
  statusSqlList,
} from "@rovenue/shared/subscription-status";
import type { Db } from "../client";
import { products, purchases, subscribers, type Purchase } from "../schema";
import { store as storeEnum } from "../enums";

type Store = (typeof storeEnum.enumValues)[number];

// =============================================================
// Extended purchase reads — used by webhook handlers + workers
// =============================================================
//
// Separated from repositories/purchases.ts (dashboard fan-out)
// so each module stays focused on one caller type.

// Accepts both the top-level db and a Drizzle tx handle, like
// repositories/purchases.ts's own alias — the claim functions below
// must be callable with a tx so their `FOR UPDATE` lock is held
// across the caller's live Google API call.
type DbOrTx = Db;

/**
 * Lookup a purchase by its store-side transaction id, scoped to the
 * project. The (store, storeTransactionId) pair is unique globally, not
 * per-project — so a webhook handler must constrain to its own
 * `ctx.projectId`, otherwise a (signature-valid) delivery routed to the
 * wrong project, or a cross-tenant store-id collision, could act on
 * another project's purchase and attribute revenue/refunds to the caller.
 * Mirrors `findPurchaseByOriginalTransaction`, which is already scoped.
 */
export async function findPurchaseByStoreTransaction(
  db: Db,
  projectId: string,
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE",
  storeTransactionId: string,
): Promise<Purchase | null> {
  const rows = await db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.store, store),
        eq(purchases.storeTransactionId, storeTransactionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Like `findPurchaseByStoreTransaction`, but also reports whether the
 * owning subscriber has been GDPR-erased.
 *
 * A separate function rather than a widened `findPurchaseByStoreTransaction`
 * because that one has nine callers across the Apple, Google, Stripe and
 * receipt-verify paths and only the Stripe invoice path needs this. One
 * LEFT JOIN, so the erasure check costs no extra round-trip.
 */
export async function findStripePurchaseWithSubscriberState(
  db: Db,
  projectId: string,
  subscriptionId: string,
): Promise<{ purchase: Purchase; subscriberDeletedAt: Date | null } | null> {
  const rows = await db
    .select({
      purchase: purchases,
      subscriberDeletedAt: subscribers.deletedAt,
    })
    .from(purchases)
    .leftJoin(subscribers, eq(purchases.subscriberId, subscribers.id))
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.store, "STRIPE"),
        eq(purchases.storeTransactionId, subscriptionId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    purchase: row.purchase,
    subscriberDeletedAt: row.subscriberDeletedAt ?? null,
  };
}

/**
 * The newest purchase under a project that matches the Apple
 * `originalTransactionId` — used by apple-webhook to reconnect
 * renewals/refunds to the subscriber record, and to read a chain's state
 * before a delivery writes to it.
 *
 * `createdAt` alone does not order a chain deterministically: the CSV
 * importer creates a whole chain inside one statement, so several rows can
 * share a timestamp to the microsecond and the "newest" was whichever the
 * planner returned. `purchaseDate` then the primary key break the tie, so
 * repeated reads of the same chain agree — it matters wherever the answer
 * decides something durable, such as whether a redemption is labelled
 * INITIAL or REACTIVATION.
 *
 * `opts.store` narrows to one store. `originalTransactionId` is Apple's
 * concept but the column is shared by all three stores, so a caller that
 * knows which store it is looking at should say so.
 */
export async function findPurchaseByOriginalTransaction(
  db: Db,
  projectId: string,
  originalTransactionId: string,
  opts?: { store?: Store },
): Promise<Purchase | null> {
  const rows = await db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.projectId, projectId),
        eq(purchases.originalTransactionId, originalTransactionId),
        ...(opts?.store ? [eq(purchases.store, opts.store)] : []),
      ),
    )
    .orderBy(
      desc(purchases.createdAt),
      desc(purchases.purchaseDate),
      desc(purchases.id),
    )
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
 * Find a single purchase by id with the product's `type`,
 * `id`, and `identifier` joined. Used by
 * webhook-processor to decide whether a completed consumable
 * purchase earns credits and to delegate to the bundle-grant service.
 */
export interface PurchaseWithCreditInfo {
  id: string;
  subscriberId: string;
  product: {
    id: string;
    identifier: string;
    type: string;
  };
}

export async function findPurchaseWithCreditInfo(
  db: Db,
  id: string,
): Promise<PurchaseWithCreditInfo | null> {
  const rows = await db
    .select({
      id: purchases.id,
      subscriberId: purchases.subscriberId,
      productId: products.id,
      productIdentifier: products.identifier,
      productType: products.type,
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
    product: {
      id: r.productId,
      identifier: r.productIdentifier,
      type: r.productType,
    },
  };
}

/**
 * Purchases owned by a subscriber with the product's access ids
 * joined in one query. Used by access-engine's syncAccess to
 * reconcile access grants against current purchases.
 */
export interface PurchaseWithAccess {
  id: string;
  subscriberId: string;
  status: Purchase["status"];
  expiresDate: Date | null;
  store: Purchase["store"];
  accessIds: string[];
}

export async function findPurchasesForSubscriberWithAccess(
  db: Db,
  subscriberId: string,
): Promise<PurchaseWithAccess[]> {
  const rows = await db
    .select({
      id: purchases.id,
      subscriberId: purchases.subscriberId,
      status: purchases.status,
      expiresDate: purchases.expiresDate,
      store: purchases.store,
      accessIds: products.accessIds,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(eq(purchases.subscriberId, subscriberId));
  return rows;
}

/**
 * Expiry sweeper helper — pulls every purchase whose expiresDate has
 * passed and whose status is one of the supplied candidates, oldest
 * expiry first, capped at `limit`. The scan is bounded by STATUS, not
 * by a time window: a purchase the sweeper missed (worker downtime, a
 * per-candidate error on an earlier run) stays in a sweepable status
 * and is picked up by the next run, however long ago it expired.
 * Caller picks the selection list based on its sweeper policy (e.g.
 * ACTIVE + GRACE_PERIOD + TRIAL) and pages a backlog across runs via
 * `limit` — processed rows leave the sweepable statuses, so each run
 * naturally consumes the next slice.
 * Served by the partial index purchases_status_expiresDate_idx.
 *
 * One status does NOT drain that way, and so is excluded here rather
 * than in the caller: a GRACE_PERIOD row's `expiresDate` is in the past
 * by definition (grace begins when the paid term lapses), so it sorts
 * FIRST under `ORDER BY expiresDate ASC` and stays a candidate for the
 * entire grace window — up to 30 days. The worker skips such a row, but
 * a skip still consumes a slot in the `limit` batch: once the
 * concurrently-open grace population exceeds the cap, every run fills
 * its batch with rows it will skip and nothing else is ever expired.
 * Excluding an open grace window in the QUERY keeps the batch full of
 * rows the sweeper can actually act on. A NULL `gracePeriodExpires` is
 * NOT an open window — it means no known window — so those rows are
 * still selected and still swept, exactly as before.
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

/**
 * The one sweepable status whose `expiresDate` is not the date that
 * governs its retirement — see the exclusion in `findOverduePurchases`.
 * Typed against the column so a rename of the enum label fails to
 * compile here rather than silently matching nothing at runtime.
 */
const GRACE_PERIOD_STATUS: Purchase["status"] = "GRACE_PERIOD";

export async function findOverduePurchases(
  db: Db,
  args: {
    now: Date;
    statuses: Array<Purchase["status"]>;
    limit: number;
  },
): Promise<ExpiryCandidate[]> {
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
        inArray(purchases.status, args.statuses),
        // NULL expiresDate (lifetime) never satisfies <=, so those rows
        // are excluded without an explicit IS NOT NULL.
        lte(purchases.expiresDate, args.now),
        // NOT (status = GRACE_PERIOD AND gracePeriodExpires > now),
        // written as the equivalent OR so NULL never swallows the row:
        // a NULL gracePeriodExpires fails `lte` in three-valued logic,
        // hence the explicit IS NULL arm that keeps it sweepable.
        or(
          ne(purchases.status, GRACE_PERIOD_STATUS),
          isNull(purchases.gracePeriodExpires),
          lte(purchases.gracePeriodExpires, args.now),
        ),
      ),
    )
    .orderBy(asc(purchases.expiresDate))
    .limit(args.limit);
  return rows as ExpiryCandidate[];
}

function rowToExpiryCandidate(row: Record<string, unknown>): ExpiryCandidate {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    subscriberId: row.subscriberId as string,
    productId: row.productId as string,
    status: row.status as Purchase["status"],
    store: row.store as Purchase["store"],
    expiresDate: toDateOrNull(row.expiresDate),
    gracePeriodExpires: toDateOrNull(row.gracePeriodExpires),
    priceAmount: (row.priceAmount as string | null) ?? null,
    priceCurrency: (row.priceCurrency as string | null) ?? null,
  };
}

/**
 * BILLING_ISSUE rows whose dunning window has fully elapsed: no store
 * (Apple, Google, or Stripe) could still be retrying the payment past
 * `args.cutoff`, so the hold is retired. Columns match `ExpiryCandidate`
 * / `findOverduePurchases` so the expiry worker's ageing pass can feed
 * both result sets to the same processing helpers without a second
 * mapper.
 *
 * `billingIssueDetectedAt IS NOT NULL` is a hard requirement, not an
 * optimization: a NULL stamp means we do not know when the hold began,
 * and ageing a row out on an unknown clock risks expiring a subscription
 * that is still genuinely being retried by its store.
 */
export async function findAgedBillingIssuePurchases(
  db: Db,
  args: { cutoff: Date; limit: number },
): Promise<ExpiryCandidate[]> {
  const result = await db.execute(sql`
    SELECT p.id,
           p."projectId"           AS "projectId",
           p."subscriberId"        AS "subscriberId",
           p."productId"           AS "productId",
           p.status,
           p.store,
           p."expiresDate"         AS "expiresDate",
           p."gracePeriodExpires"  AS "gracePeriodExpires",
           p."priceAmount"         AS "priceAmount",
           p."priceCurrency"       AS "priceCurrency"
    FROM ${purchases} p
    WHERE p.status = 'BILLING_ISSUE'
      AND p."billingIssueDetectedAt" IS NOT NULL
      AND p."billingIssueDetectedAt" < ${args.cutoff}
    ORDER BY p."billingIssueDetectedAt" ASC
    LIMIT ${args.limit}
  `);
  const rows =
    (result as unknown as { rows: Array<Record<string, unknown>> }).rows ??
    [];
  return rows.map(rowToExpiryCandidate);
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

// =============================================================
// Google reconciliation sweep (workers/google-reconciliation.ts)
// =============================================================
//
// Two-step claim, mirroring the expiry sweeper (a plain, non-locking
// scan builds this run's worklist) plus the refund-shield-responder
// per-row `FOR UPDATE SKIP LOCKED` claim (each id is locked, verified
// against Google, and corrected inside ONE short transaction). The
// two-step split matters: locking the whole worklist up front would
// hold N row locks across N sequential Google HTTP calls; claiming
// one id at a time means a slow or failing candidate blocks nothing
// else in the batch, and a second concurrent sweep instance simply
// SKIPs a row the first is already holding.
//
// The WHERE clause is identical between the two queries (see
// `googleReconciliationIdx`, migration 0114) so a row the worklist
// selected can still fail to claim if a concurrent sweep already
// corrected it (lastReconciledAt now fresh) or a live webhook moved
// it out of the sweepable statuses in between — both cases correctly
// resolve to "nothing to do here" rather than a lost update.

export interface GoogleReconciliationCandidate {
  id: string;
  projectId: string;
  subscriberId: string;
  productId: string;
  productIdentifier: string;
  status: Purchase["status"];
  expiresDate: Date | null;
  storeTransactionId: string;
  originalTransactionId: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  lastReconciledAt: Date | null;
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string);
}

function rowToCandidate(
  row: Record<string, unknown>,
): GoogleReconciliationCandidate {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    subscriberId: row.subscriberId as string,
    productId: row.productId as string,
    productIdentifier: row.productIdentifier as string,
    status: row.status as Purchase["status"],
    expiresDate: toDateOrNull(row.expiresDate),
    storeTransactionId: row.storeTransactionId as string,
    originalTransactionId: row.originalTransactionId as string,
    priceAmount: (row.priceAmount as string | null) ?? null,
    priceCurrency: (row.priceCurrency as string | null) ?? null,
    lastReconciledAt: toDateOrNull(row.lastReconciledAt),
  };
}

/**
 * Non-locking scan: every PLAY_STORE purchase either (a) past its
 * expiry while still ACTIVE — RTDN's EXPIRED notification never
 * arrived — or (b) not reconciled within `staleBefore`. NULL
 * `lastReconciledAt` ("never checked") sorts first via `NULLS FIRST`.
 * Capped at `limit` — the caller's named per-sweep constant.
 *
 * The status predicate is `RECONCILABLE_STATUSES`, derived from the shared
 * semantics table (review finding 2, 2026-09-04) — it includes
 * BILLING_ISSUE (declared `reconcilable: true`, `sweepable: false`): a
 * held row is invisible to the expiry sweeper by design, so THIS sweep is
 * its only automated path back to ACTIVE (or forward to EXPIRED) when the
 * recovery/hold-exhausted RTDN was itself lost. Must match
 * `purchases_google_reconciliation_idx` in schema.ts, built from the same
 * derived list, or this scan stops using that partial index.
 */
export async function selectGoogleReconciliationCandidateIds(
  db: Db,
  args: { now: Date; staleBefore: Date; limit: number },
): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT p.id
    FROM ${purchases} p
    WHERE p.store = 'PLAY_STORE'
      AND p.status IN (${sql.raw(statusSqlList(RECONCILABLE_STATUSES))})
      AND (
        (p.status = 'ACTIVE' AND p."expiresDate" < ${args.now})
        OR p."lastReconciledAt" IS NULL
        OR p."lastReconciledAt" < ${args.staleBefore}
      )
    ORDER BY p."lastReconciledAt" ASC NULLS FIRST, p."expiresDate" ASC NULLS LAST
    LIMIT ${args.limit}
  `);
  const rows =
    (result as unknown as { rows: Array<{ id: string }> }).rows ?? [];
  return rows.map((r) => r.id);
}

/**
 * Locks exactly one row (by primary key) with the same eligibility
 * predicate `selectGoogleReconciliationCandidateIds` used (see that
 * function's doc for the RECONCILABLE_STATUSES / BILLING_ISSUE note), via
 * `FOR UPDATE OF p SKIP LOCKED`. Returns null when another sweep
 * instance already holds the row, or the row is no longer eligible
 * (already reconciled, or moved out of a reconcilable status by a
 * concurrent webhook) — both are "nothing to do", not an error.
 */
export async function claimGoogleReconciliationCandidateById(
  db: DbOrTx,
  args: { id: string; now: Date; staleBefore: Date },
): Promise<GoogleReconciliationCandidate | null> {
  const result = await db.execute(sql`
    SELECT p.id,
           p."projectId"              AS "projectId",
           p."subscriberId"           AS "subscriberId",
           p."productId"              AS "productId",
           pr.identifier               AS "productIdentifier",
           p.status,
           p."expiresDate"            AS "expiresDate",
           p."storeTransactionId"     AS "storeTransactionId",
           p."originalTransactionId"  AS "originalTransactionId",
           p."priceAmount"            AS "priceAmount",
           p."priceCurrency"          AS "priceCurrency",
           p."lastReconciledAt"       AS "lastReconciledAt"
    FROM ${purchases} p
    JOIN ${products} pr ON pr.id = p."productId"
    WHERE p.id = ${args.id}
      AND p.store = 'PLAY_STORE'
      AND p.status IN (${sql.raw(statusSqlList(RECONCILABLE_STATUSES))})
      AND (
        (p.status = 'ACTIVE' AND p."expiresDate" < ${args.now})
        OR p."lastReconciledAt" IS NULL
        OR p."lastReconciledAt" < ${args.staleBefore}
      )
    FOR UPDATE OF p SKIP LOCKED
  `);
  const rows =
    (result as unknown as { rows: Array<Record<string, unknown>> }).rows ??
    [];
  const row = rows[0];
  return row ? rowToCandidate(row) : null;
}

/**
 * Rows in the same Apple subscription chain that the incoming
 * transaction replaced. Deliberately narrow: an Apple chain holds one
 * row per BILLING PERIOD (each renewal gets its own transactionId), so
 * matching on originalTransactionId alone would sweep the entire
 * renewal history. Every conjunct earns its place:
 *   - projectId + store = 'APP_STORE': scope to this tenant's Apple rows.
 *   - originalTransactionId: the subscription chain the upgrade belongs to.
 *   - storeTransactionId <> excludeStoreTransactionId: never self-expire
 *     the incoming (upgrade) row itself.
 *   - status NOT IN (TERMINAL_STATUSES): a REFUNDED/REVOKED sibling stays
 *     put — the guard would reject the write anyway, but excluding it
 *     here keeps the candidate set (and the audit trail) honest.
 *   - expiresDate IS NOT NULL AND expiresDate > now: the load-bearing
 *     bound. Past billing periods already have PAST expiries and fall
 *     out on this condition alone — without it, every prior renewal row
 *     would be swept too, rewriting the subscription's entire history.
 *     Only a row whose period has NOT yet ended can be the one an
 *     upgrade cut short.
 */
export async function findSupersedableApplePurchases(
  db: Db,
  args: {
    projectId: string;
    originalTransactionId: string;
    excludeStoreTransactionId: string;
    now: Date;
  },
): Promise<
  Array<{
    id: string;
    storeTransactionId: string;
    subscriberId: string;
    // The tier being replaced. Callers emit it as the `previousProductId`
    // of `subscription.product_changed`: on an Apple upgrade the replacing
    // transaction gets a NEW transactionId, so the guard's before-image is
    // null and THIS row is the only honest source of the old product.
    productId: string;
    status: Purchase["status"];
  }>
> {
  const result = await db.execute(sql`
    SELECT p.id,
           p."storeTransactionId" AS "storeTransactionId",
           p."subscriberId"       AS "subscriberId",
           p."productId"          AS "productId",
           p.status
    FROM ${purchases} p
    WHERE p."projectId" = ${args.projectId}
      AND p.store = 'APP_STORE'
      AND p."originalTransactionId" = ${args.originalTransactionId}
      AND p."storeTransactionId" <> ${args.excludeStoreTransactionId}
      AND p.status NOT IN (${sql.raw(statusSqlList(TERMINAL_STATUSES))})
      AND p."expiresDate" IS NOT NULL
      AND p."expiresDate" > ${args.now}
  `);
  const rows =
    (result as unknown as {
      rows: Array<{
        id: string;
        storeTransactionId: string;
        subscriberId: string;
        productId: string;
        status: Purchase["status"];
      }>;
    }).rows ?? [];
  return rows;
}

// Export sql for callers that need to compose additional
// conditions on top of what the repo exposes.
export { sql };
