// Dry-run planner for the data-import tool (Task 6).
//
// Parses a job's stored file through its confirmed mapping, classifies
// every row into exactly one outcome bucket (report.ts's IMPORT_OUTCOMES),
// and streams a report artefact — WITHOUT writing a single subscriber,
// purchase or revenue-event row. That last property is the entire point:
// the dry run is the operator's only chance to discover a bad mapping or
// a structural blocker (an unresolvable product, a purchases.NOT NULL
// violation waiting to happen) before the real run commits anything.
import type { Readable } from "node:stream";
import {
  drizzle,
  describeRequiredPartitionSpan,
  type Db,
  type Product,
  type Purchase,
} from "@rovenue/db";
import {
  parseCsvStream,
  normalizeRow,
  IMPORT_DUPLICATE_TRACKING_MAX_KEYS,
  type CanonicalField,
  type CanonicalRow,
  type StoreValue,
} from "@rovenue/shared";
import * as importStore from "../../lib/import-store";
import {
  IMPORT_OUTCOMES,
  createReportWriter,
  buildDryRunCounters,
  type ImportOutcome,
  type ReportRow,
} from "./report";

export type ImportPlanSummary = {
  jobId: string;
  totalRows: number;
  /** Final-fix-wave minor fix: true when an operator's `/cancel` was
   *  noticed mid-scan (checked at `DRY_RUN_CANCELLATION_CHECK_INTERVAL_MS`
   *  intervals — see the module comment). Before this fix, `planImport`
   *  never checked cancellation at all: `/cancel` on a `DRY_RUN_RUNNING`
   *  job wrote `CANCELLED` immediately, but the still-running scan wrote
   *  `DRY_RUN_COMPLETE` right over it moments later, on its own read-then-
   *  write with no status guard. When true, every field below reflects
   *  only the PARTIAL scan up to the moment cancellation was noticed, and
   *  nothing was persisted to the job row — the row stays `CANCELLED`. */
  cancelled: boolean;
  outcomes: Record<ImportOutcome, number>;
  /** Observed shapes of the raw `entitlement_identifiers` cell across the
   *  file, keyed by shape name with a count each (task-6 controller
   *  context, carried-forward item 2). This is OBSERVATION, not parsing:
   *  RC changed its bracket convention between export versions and which
   *  shape a given customer's file actually uses is confirmed here, from
   *  their real data, rather than re-guessed. Rows with no entitlement
   *  cell at all are not counted in any shape bucket. */
  entitlementShapeCounts: Record<string, number>;
  /**
   * Null while every distinct `(store, storeTransactionId)` key seen so
   * far was tracked exactly; set to `IMPORT_DUPLICATE_TRACKING_MAX_KEYS`
   * the moment the tracker hit that cap and stopped accepting new keys
   * (fix round 1, FIX 2). A non-null value here means `duplicateInFile`
   * detection was NOT exhaustive for the remainder of the file — some
   * later in-file duplicates may have been missed (never falsely
   * flagged; see `isDuplicateAndTrack`). Surfaced so the operator sees
   * this honestly rather than the summary silently going quiet on it.
   */
  duplicateTrackingDisabledAfterKeys: number | null;
  /**
   * Observed [min, max] `purchaseDate` (the value the writer uses as
   * `revenue_events.eventDate` — write.ts) across every row this dry run
   * could normalize a date for, regardless of which outcome bucket the
   * row landed in. Null when the file had no row with a normalizable
   * date at all (task 8a: the operator must see this range BEFORE
   * committing, since `revenue_events` is range-partitioned with no
   * default partition and a row outside every provisioned partition
   * fails the write outright).
   */
  observedEventDateRange: { min: string; max: string } | null;
  /**
   * The monthly partition span `ensureRevenueEventPartitions`
   * (@rovenue/db) would provision to cover `observedEventDateRange` —
   * not narrowed to only the months that don't already have a
   * partition, since provisioning an existing month is a safe no-op and
   * checking "already exists" here would cost a round trip this dry run
   * doesn't otherwise need. Null exactly when `observedEventDateRange`
   * is null.
   */
  requiredPartitionSpan: { fromMonth: string; toMonth: string; monthCount: number } | null;
  /** Null iff `cancelled` — a cancelled scan never finishes a report the
   *  job row can point at. */
  reportStorageKey: string | null;
};

const DEFAULT_SKIP_SANDBOX = true;

/** Final-fix-wave minor fix: how often (at most) `planImport` re-reads
 *  the job's own status to notice an operator's `/cancel` — same
 *  wall-clock-cadence reasoning as verify.ts's own
 *  `CANCELLATION_CHECK_INTERVAL_MS` (a dry-run scan has no natural
 *  "batch" boundary to check at, and checking every row would cost one
 *  extra DB round trip per row on a huge file). Before this fix,
 *  `planImport` never checked cancellation at all — `/cancel` on a
 *  `DRY_RUN_RUNNING` job wrote `CANCELLED` immediately, but the
 *  still-running scan clobbered it moments later with `DRY_RUN_COMPLETE`
 *  on its own unconditional status write. */
const DRY_RUN_CANCELLATION_CHECK_INTERVAL_MS = 2_000;

// =============================================================
// Canonical-row assembly
// =============================================================

/** Rewrites one raw CSV row onto canonical field names using the job's
 *  confirmed mapping. Columns with no mapped canonical field are simply
 *  dropped — the mapping is the single gate a column must pass through,
 *  same as the mapping-validation module (mapping.ts) treats it. */
export function buildCanonicalRow(
  header: string[],
  row: string[],
  mapping: Record<string, CanonicalField>,
): CanonicalRow {
  const out: Partial<Record<CanonicalField, string>> = {};
  for (let i = 0; i < header.length; i++) {
    const field = mapping[header[i]!];
    if (field) {
      out[field] = row[i];
    }
  }
  return out;
}

// =============================================================
// Entitlement raw-shape observation
// =============================================================

function classifyEntitlementShape(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return "json_array";
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return "curly_braces";
  if (trimmed.includes(";")) return "semicolon_delimited";
  if (trimmed.includes(",")) return "comma_delimited";
  return "single_value";
}

// =============================================================
// Product resolution
// =============================================================
//
// RC's Stripe `product_identifier` is documented to be a mix of
// `price_...`, `prod_...` and custom strings within one file (design spec
// §3, research doc) — there is no separate column that says which shape a
// given row uses, and no schema field here that distinguishes a Stripe
// price id from a Stripe product id (`products.storeIds.stripe` holds
// whichever single string the operator configured for that store).
//
// Fix round 1, FIX 1 (critical): the original two-step "try storeIds,
// then fall back to products.identifier" resolver could silently bind a
// purchase to the WRONG product. `prod_...` (a Stripe PARENT id) is
// inherently coarser than a plan — two catalog products (e.g. "Monthly"
// and "Annual") can be built on one Stripe Product while holding distinct
// Price ids, and `products.storeIds` is unconstrained jsonb, so nothing
// stops an operator from entering that shared `prod_...` on only one of
// them. Every purchase row carrying that coarser id would then
// exact-match that ONE product regardless of which plan it actually
// belongs to — real customers silently granted the wrong entitlements,
// strictly worse than the `unresolvedProduct` bucket this design fails
// closed into everywhere else.
//
// Ruling (binding): resolution must be unambiguous or it must fail
// closed. Two rules, both enforced below:
//   1. A storeIds match must be UNIQUE. `findProductsByStoreId` (no
//      `.limit(1)`) returns every matching product; more than one means
//      ambiguous, not resolved — report it as such rather than picking
//      one.
//   2. The `products.identifier` fallback NEVER resolves a value shaped
//      like a Stripe id (`price_...`/`prod_...`). `products.identifier`
//      is a Rovenue-side slug; a value shaped like a Stripe id matching
//      it is coincidence, not identity. A genuinely custom string (RC's
//      third documented shape) still falls back normally — only the
//      store-shaped case is gated off, and only for STRIPE rows, since
//      Apple bundle ids / Google SKUs have no documented coincidental-
//      shape risk the way Stripe's product_identifier does.
const STORE_TO_PRODUCT_STORE_KEY: Partial<Record<StoreValue, "apple" | "google" | "stripe">> = {
  APP_STORE: "apple",
  PLAY_STORE: "google",
  STRIPE: "stripe",
};

/** Stripe's own id namespace signature — a Price id or a (legacy) Product
 *  id. A value shaped like this did NOT come from an operator typing
 *  their own catalog slug; it came from Stripe. */
const STRIPE_ID_PATTERN = /^(price_|prod_)/;

function looksLikeStripeId(value: string): boolean {
  return STRIPE_ID_PATTERN.test(value);
}

export type ProductResolution =
  | { kind: "resolved"; product: Product }
  | { kind: "unresolved" }
  | { kind: "ambiguous"; matchCount: number };

/** Exported so the Phase A writer (`write.ts`) resolves products through
 *  the EXACT same rules the dry run previewed. A second, subtly different
 *  resolver would let the writer bind a purchase to a product the report
 *  told the operator was unresolvable. */
export async function resolveProduct(
  db: Db,
  projectId: string,
  store: StoreValue,
  productIdentifier: string,
): Promise<ProductResolution> {
  const storeKey = STORE_TO_PRODUCT_STORE_KEY[store];
  if (storeKey) {
    const matches = await drizzle.offeringRepo.findProductsByStoreId(
      db,
      projectId,
      storeKey,
      productIdentifier,
    );
    if (matches.length > 1) {
      return { kind: "ambiguous", matchCount: matches.length };
    }
    if (matches.length === 1) {
      return { kind: "resolved", product: matches[0]! };
    }
  }

  // No unique storeIds match. Fall back to our own canonical identifier —
  // unless the value is shaped like a Stripe id, in which case a
  // coincidental match against products.identifier is not identity (rule
  // 2 above). products.identifier is unique per project (schema), so this
  // branch can never itself be ambiguous.
  if (store === "STRIPE" && looksLikeStripeId(productIdentifier)) {
    return { kind: "unresolved" };
  }
  const byIdentifier = await drizzle.productRepo.findProductByIdentifier(
    db,
    projectId,
    productIdentifier,
  );
  return byIdentifier ? { kind: "resolved", product: byIdentifier } : { kind: "unresolved" };
}

// =============================================================
// Duplicate-key tracking (fix round 1, FIX 2 — bounded)
// =============================================================
//
// Tracking every distinct (store, storeTransactionId) key for the whole
// run is unbounded: at the 2 GiB upload cap and realistic row sizes that
// is on the order of ten million keys (hundreds of MB to a GB resident).
// `duplicateInFile` is informational, not a correctness guarantee — the
// writer upserts on (store, storeTransactionId) regardless, so a missed
// in-file duplicate costs a redundant upsert, never a wrong one. So: track
// up to a named cap, and past it STOP tracking new keys rather than
// guess via a lossy hash (a false "duplicate" would wrongly skip a real
// row — a correctness failure in the wrong direction, unlike a missed
// one). `disabledAfterKeys` records, once, that the cap was hit, so the
// summary can say so rather than silently going quiet.
export type DuplicateTracker = {
  seen: Set<string>;
  disabledAfterKeys: number | null;
};

export function createDuplicateTracker(): DuplicateTracker {
  return { seen: new Set(), disabledAfterKeys: null };
}

/** Returns true when `key` was already tracked (a genuine duplicate).
 *  Never returns true for a key it hasn't actually seen before — once the
 *  cap is reached, a brand-new key is simply left untracked, not flagged. */
export function isDuplicateAndTrack(
  tracker: DuplicateTracker,
  key: string,
  cap: number,
): boolean {
  if (tracker.seen.has(key)) return true;
  if (tracker.seen.size < cap) {
    tracker.seen.add(key);
  } else if (tracker.disabledAfterKeys === null) {
    tracker.disabledAfterKeys = cap;
  }
  return false;
}

// =============================================================
// Row classification
// =============================================================
//
// Bucket precedence when a row would otherwise fit more than one bucket
// (every row must land in exactly one — task-6 brief/context):
//
//   1. invalidRow        — normalizeRow() itself rejects the row (missing
//                           required identity, unknown store, unparseable
//                           timestamp, or a non-anchorless row with no
//                           store transaction id). Nothing downstream is
//                           computable without a normalized row.
//   2. duplicateInFile   — a second row with the same (store,
//                           storeTransactionId) as an earlier row in this
//                           SAME file. Checked before catalog/store-specific
//                           checks so a dupe is reported once, as a dupe,
//                           rather than also being counted toward
//                           unresolved/anchorless/etc downstream. Only
//                           keyable when storeTransactionId is non-null —
//                           a true anchorless row with no real transaction
//                           id can't collide this way.
//   3. unresolvedProduct — `purchases.productId` is NOT NULL (schema), so
//                           an unresolvable product is a structural
//                           blocker for ANY row, anchorless or not. Never
//                           invents a catalog entry.
//   4. anchorless        — isAnchorless (RC `promotional`/manual grant).
//                           Its own bucket regardless of whether it
//                           carries a real store_transaction_id (fix 4c
//                           preserves that value; it does not change the
//                           bucket).
//   5. androidNoToken     — PLAY_STORE with no googlePurchaseToken mapped.
//                           RC's primary Transactions export never carries
//                           one; only the separate 3-column Google-token
//                           file does. A live entitlement can't be granted
//                           without it, so this is checked ahead of the
//                           routine sandbox filter.
//   6. skippedSandbox     — isSandbox, and options.skipSandbox is not
//                           explicitly false (default true).
//   7. willUpdate/willCreate — everything else: an existing purchase for
//                           this (store, storeTransactionId) means
//                           willUpdate, otherwise willCreate.
//
// Carry-forward 1 (originalTransactionId NOT NULL, RC Transactions preset
// has no such column): by the time a row reaches step 7, normalizeRow has
// already guaranteed storeTransactionId is non-null for every
// NON-anchorless row (step 1 rejects a non-anchorless row with none as
// MISSING_STORE_TRANSACTION_ID), and anchorless rows never reach step 7
// at all (bucketed at step 4). The writer's obvious fallback —
// `originalTransactionId ?? storeTransactionId`, mirroring grant.ts's own
// `originalTransactionId: storeTransactionId` convention for a MANUAL
// grant — therefore always resolves to a real, non-null value on every
// row this planner reports as willCreate/willUpdate. No row can be
// reported willCreate/willUpdate and then fail that NOT NULL constraint
// at write time.
async function classifyRow(args: {
  db: Db;
  projectId: string;
  canonicalRow: CanonicalRow;
  now: Date;
  skipSandbox: boolean;
  duplicateTracker: DuplicateTracker;
}): Promise<{
  outcome: ImportOutcome;
  reason: string | null;
  existingSubscriberId: string | null;
  /** The row's `purchaseDate` (== the eventDate a write would use), or
   *  null when the row never normalized far enough to have one. Task
   *  8a: `planImport` tracks the min/max of this across the whole file
   *  to report the partition span the import would need. */
  eventDate: Date | null;
}> {
  const { db, projectId, canonicalRow, now, skipSandbox, duplicateTracker } = args;

  const normalized = normalizeRow(canonicalRow, { now });
  if ("error" in normalized) {
    return {
      outcome: "invalidRow",
      reason: normalized.error.message,
      existingSubscriberId: null,
      eventDate: null,
    };
  }
  const eventDate = normalized.purchaseDate;

  // Identity resolution (design spec §"resolve identities"): the SAME
  // merge-chain-following resolver every SDK write path uses
  // (resolve-subscriber.ts), called here in pure read mode — it only
  // selects, it never creates or reassigns anything. This is
  // informational (surfaced on the report row) rather than bucket-gating:
  // a subscriber that doesn't exist yet is simply one the real run will
  // create, which is not a defect a dry run needs to flag.
  const existingSubscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(db, {
    projectId,
    key: normalized.subscriberExternalId,
  });
  const existingSubscriberId = existingSubscriber?.id ?? null;

  if (normalized.storeTransactionId) {
    const dedupeKey = `${normalized.store}:${normalized.storeTransactionId}`;
    if (
      isDuplicateAndTrack(duplicateTracker, dedupeKey, IMPORT_DUPLICATE_TRACKING_MAX_KEYS)
    ) {
      return {
        outcome: "duplicateInFile",
        reason: `duplicate (store, storeTransactionId) already seen earlier in this file: ${dedupeKey}`,
        existingSubscriberId,
        eventDate,
      };
    }
  }

  const productResolution = await resolveProduct(
    db,
    projectId,
    normalized.store,
    normalized.productIdentifier,
  );
  if (productResolution.kind === "ambiguous") {
    return {
      outcome: "unresolvedProduct",
      reason:
        `product ambiguous: product identifier "${normalized.productIdentifier}" matches ` +
        `${productResolution.matchCount} catalog products — fix the catalog's storeIds mapping ` +
        `so only one product claims this id`,
      existingSubscriberId,
      eventDate,
    };
  }
  if (productResolution.kind === "unresolved") {
    return {
      outcome: "unresolvedProduct",
      reason: `product not found: no catalog product matches product identifier "${normalized.productIdentifier}"`,
      existingSubscriberId,
      eventDate,
    };
  }
  // productResolution.kind === "resolved" past this point — the product
  // row itself isn't needed downstream, only the fact that resolution
  // succeeded (Task 7's writer does its own lookup at write time).

  if (normalized.isAnchorless) {
    return { outcome: "anchorless", reason: null, existingSubscriberId, eventDate };
  }

  if (normalized.store === "PLAY_STORE" && !normalized.googlePurchaseToken) {
    return {
      outcome: "androidNoToken",
      reason: "PLAY_STORE row has no Google purchase token mapped — access cannot be granted live",
      existingSubscriberId,
      eventDate,
    };
  }

  if (normalized.isSandbox && skipSandbox) {
    return { outcome: "skippedSandbox", reason: null, existingSubscriberId, eventDate };
  }

  // Guaranteed non-null here: normalizeRow rejects a non-anchorless row
  // with no storeTransactionId (MISSING_STORE_TRANSACTION_ID, step 1
  // above) before this point is ever reached — TypeScript can't see that
  // business-logic invariant across the two functions, hence the assertion.
  const existingPurchase: Purchase | null = await drizzle.purchaseRepo.findPurchaseByStoreTransaction(
    db,
    normalized.store,
    normalized.storeTransactionId!,
  );
  return {
    outcome: existingPurchase ? "willUpdate" : "willCreate",
    reason: null,
    existingSubscriberId,
    eventDate,
  };
}

// =============================================================
// planImport
// =============================================================

export interface PlanImportOptions {
  /** Overridable for tests only — production always gets the real,
   *  interval-paced DB status check. Mirrors verify.ts's own
   *  `deps.isCancelled` seam (fix round 2, FIX C there): a test can
   *  inject a scripted predicate to prove cancellation is noticed
   *  mid-scan without waiting on real wall-clock time
   *  (`DRY_RUN_CANCELLATION_CHECK_INTERVAL_MS`). */
  isCancelled?: () => Promise<boolean>;
}

export async function planImport(
  jobId: string,
  options: PlanImportOptions = {},
): Promise<ImportPlanSummary> {
  const db = drizzle.db;
  const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
  if (!job) {
    throw new Error(`planImport: import job ${jobId} not found`);
  }

  const mapping = job.mapping as Record<string, CanonicalField>;
  const skipSandbox = job.options?.skipSandbox ?? DEFAULT_SKIP_SANDBOX;

  await drizzle.importJobRepo.setImportJobStatus(db, job.projectId, job.id, {
    status: "DRY_RUN_RUNNING",
    startedAt: new Date(),
  });

  const outcomes = Object.fromEntries(
    IMPORT_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<ImportOutcome, number>;
  const entitlementShapeCounts: Record<string, number> = {};
  const duplicateTracker = createDuplicateTracker();
  let totalRows = 0;
  const now = new Date();
  // Task 8a: observed span across every row with a normalizable date,
  // regardless of outcome bucket — see ImportPlanSummary's field docs.
  let minEventDate: Date | null = null;
  let maxEventDate: Date | null = null;

  const reportWriter = createReportWriter(job.projectId, job.id);

  let cancelled = false;
  let lastCancelCheckAt = 0;

  try {
    const objectStream: Readable = await importStore.getObject(job.storageKey);
    let header: string[] = [];

    for await (const event of parseCsvStream(objectStream)) {
      if ("header" in event) {
        header = event.header;
        continue;
      }

      if (options.isCancelled) {
        if (await options.isCancelled()) {
          cancelled = true;
          break;
        }
      } else {
        const nowMs = Date.now();
        if (nowMs - lastCancelCheckAt >= DRY_RUN_CANCELLATION_CHECK_INTERVAL_MS) {
          lastCancelCheckAt = nowMs;
          const fresh = await drizzle.importJobRepo.getImportJob(db, job.projectId, job.id);
          if (fresh?.status === "CANCELLED") {
            cancelled = true;
            break;
          }
        }
      }

      totalRows += 1;

      const canonicalRow = buildCanonicalRow(header, event.row, mapping);

      const rawEntitlements = canonicalRow.entitlementIdentifiers?.trim();
      if (rawEntitlements) {
        const shape = classifyEntitlementShape(rawEntitlements);
        entitlementShapeCounts[shape] = (entitlementShapeCounts[shape] ?? 0) + 1;
      }

      const { outcome, reason, existingSubscriberId, eventDate } = await classifyRow({
        db,
        projectId: job.projectId,
        canonicalRow,
        now,
        skipSandbox,
        duplicateTracker,
      });

      outcomes[outcome] += 1;

      if (eventDate !== null) {
        if (minEventDate === null || eventDate.getTime() < minEventDate.getTime()) {
          minEventDate = eventDate;
        }
        if (maxEventDate === null || eventDate.getTime() > maxEventDate.getTime()) {
          maxEventDate = eventDate;
        }
      }

      const reportRow: ReportRow = {
        lineNumber: event.lineNumber,
        outcome,
        subscriberExternalId: canonicalRow.subscriberExternalId ?? null,
        existingSubscriberId,
        store: canonicalRow.store ?? null,
        productIdentifier: canonicalRow.productIdentifier ?? null,
        storeTransactionId: canonicalRow.storeTransactionId ?? null,
        reason,
      };
      await reportWriter.writeReportRow(reportRow);
    }

    const observedEventDateRange =
      minEventDate !== null && maxEventDate !== null
        ? { min: minEventDate.toISOString(), max: maxEventDate.toISOString() }
        : null;
    const requiredPartitionSpan =
      minEventDate !== null && maxEventDate !== null
        ? describeRequiredPartitionSpan(minEventDate, maxEventDate)
        : null;

    if (cancelled) {
      // Close the report stream for cleanliness (avoid a dangling
      // multipart upload) but do NOT point the job at it, and do NOT
      // touch counters/dryRunSummary/status — the row is already
      // CANCELLED (that is how this was detected), and every value
      // computed above reflects only the PARTIAL scan up to the moment
      // cancellation was noticed.
      await reportWriter.finalizeReport().catch(() => undefined);
      return {
        jobId: job.id,
        cancelled: true,
        totalRows,
        outcomes,
        entitlementShapeCounts,
        duplicateTrackingDisabledAfterKeys: duplicateTracker.disabledAfterKeys,
        observedEventDateRange,
        requiredPartitionSpan,
        reportStorageKey: null,
      };
    }

    const reportStorageKey = await reportWriter.finalizeReport();

    // Final-fix-wave FIX 3: OVERWRITE this job's dry-run counter
    // namespace, never additive — a dry-run attempt is always a
    // complete, from-scratch scan of the whole file, so re-running it
    // (e.g. after fixing the mapping) must replace the previous attempt's
    // counts, not stack on top of them. `buildDryRunCounters` also keeps
    // these keys structurally separate from the commit run's own
    // (`incrementImportJobCounters` in workers/import-runner.ts), which
    // is what stops a dry-run-then-commit from ever doubling a bucket.
    await drizzle.importJobRepo.setImportJobCounters(
      db,
      job.projectId,
      job.id,
      buildDryRunCounters(outcomes),
    );
    // Final-fix-wave FIX 7: persist the disclosures this dry run computed
    // — before this, `entitlementShapeCounts`,
    // `duplicateTrackingDisabledAfterKeys`, `observedEventDateRange` and
    // `requiredPartitionSpan` were returned from this function and then
    // thrown away (nothing reads a BullMQ job's `returnvalue`). Same
    // overwrite reasoning as the counters call above.
    await drizzle.importJobRepo.setImportJobDryRunSummary(db, job.projectId, job.id, {
      entitlementShapeCounts,
      duplicateTrackingDisabledAfterKeys: duplicateTracker.disabledAfterKeys,
      observedEventDateRange,
      requiredPartitionSpan,
    });
    await drizzle.importJobRepo.setImportJobStatus(db, job.projectId, job.id, {
      status: "DRY_RUN_COMPLETE",
      reportStorageKey,
      finishedAt: new Date(),
    });

    return {
      jobId: job.id,
      cancelled: false,
      totalRows,
      outcomes,
      entitlementShapeCounts,
      duplicateTrackingDisabledAfterKeys: duplicateTracker.disabledAfterKeys,
      observedEventDateRange,
      requiredPartitionSpan,
      reportStorageKey,
    };
  } catch (err) {
    await drizzle.importJobRepo
      .setImportJobStatus(db, job.projectId, job.id, {
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
      .catch(() => undefined);
    throw err;
  }
}
