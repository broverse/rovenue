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
import { drizzle, type Db, type Product, type Purchase } from "@rovenue/db";
import {
  parseCsvStream,
  normalizeRow,
  type CanonicalField,
  type CanonicalRow,
  type StoreValue,
} from "@rovenue/shared";
import * as importStore from "../../lib/import-store";
import {
  IMPORT_OUTCOMES,
  createReportWriter,
  type ImportOutcome,
  type ReportRow,
} from "./report";

export type ImportPlanSummary = {
  jobId: string;
  totalRows: number;
  outcomes: Record<ImportOutcome, number>;
  /** Observed shapes of the raw `entitlement_identifiers` cell across the
   *  file, keyed by shape name with a count each (task-6 controller
   *  context, carried-forward item 2). This is OBSERVATION, not parsing:
   *  RC changed its bracket convention between export versions and which
   *  shape a given customer's file actually uses is confirmed here, from
   *  their real data, rather than re-guessed. Rows with no entitlement
   *  cell at all are not counted in any shape bucket. */
  entitlementShapeCounts: Record<string, number>;
  reportStorageKey: string;
};

const DEFAULT_SKIP_SANDBOX = true;

// =============================================================
// Canonical-row assembly
// =============================================================

/** Rewrites one raw CSV row onto canonical field names using the job's
 *  confirmed mapping. Columns with no mapped canonical field are simply
 *  dropped — the mapping is the single gate a column must pass through,
 *  same as the mapping-validation module (mapping.ts) treats it. */
function buildCanonicalRow(
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
// Rather than guess which of the three shapes a value is, this tries the
// two catalog fields a value could plausibly match, in order, and takes
// the first hit — never fabricating a product for a value that matches
// neither:
//   1. `products.storeIds[<canonical store key>]` — the native mapping
//      every other store (Apple bundle id, Google SKU) already resolves
//      through (`offeringRepo.findProductByStoreId`, used by every store
//      webhook). Covers a Stripe price id when that's what the operator
//      configured, and is the ONLY path for Apple/Google rows.
//   2. `products.identifier` — our own canonical catalog identifier.
//      Covers a Stripe product id or a custom string that happens to
//      equal how the operator named the product in their own catalog.
const STORE_TO_PRODUCT_STORE_KEY: Partial<Record<StoreValue, "apple" | "google" | "stripe">> = {
  APP_STORE: "apple",
  PLAY_STORE: "google",
  STRIPE: "stripe",
};

async function resolveProduct(
  db: Db,
  projectId: string,
  store: StoreValue,
  productIdentifier: string,
): Promise<Product | null> {
  const storeKey = STORE_TO_PRODUCT_STORE_KEY[store];
  if (storeKey) {
    const byStoreId = await drizzle.offeringRepo.findProductByStoreId(
      db,
      projectId,
      storeKey,
      productIdentifier,
    );
    if (byStoreId) return byStoreId;
  }
  return drizzle.productRepo.findProductByIdentifier(db, projectId, productIdentifier);
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
  seenTransactionKeys: Set<string>;
}): Promise<{ outcome: ImportOutcome; reason: string | null; existingSubscriberId: string | null }> {
  const { db, projectId, canonicalRow, now, skipSandbox, seenTransactionKeys } = args;

  const normalized = normalizeRow(canonicalRow, { now });
  if ("error" in normalized) {
    return { outcome: "invalidRow", reason: normalized.error.message, existingSubscriberId: null };
  }

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
    if (seenTransactionKeys.has(dedupeKey)) {
      return {
        outcome: "duplicateInFile",
        reason: `duplicate (store, storeTransactionId) already seen earlier in this file: ${dedupeKey}`,
        existingSubscriberId,
      };
    }
    seenTransactionKeys.add(dedupeKey);
  }

  const product = await resolveProduct(
    db,
    projectId,
    normalized.store,
    normalized.productIdentifier,
  );
  if (!product) {
    return {
      outcome: "unresolvedProduct",
      reason: `no catalog product matches product identifier "${normalized.productIdentifier}"`,
      existingSubscriberId,
    };
  }

  if (normalized.isAnchorless) {
    return { outcome: "anchorless", reason: null, existingSubscriberId };
  }

  if (normalized.store === "PLAY_STORE" && !normalized.googlePurchaseToken) {
    return {
      outcome: "androidNoToken",
      reason: "PLAY_STORE row has no Google purchase token mapped — access cannot be granted live",
      existingSubscriberId,
    };
  }

  if (normalized.isSandbox && skipSandbox) {
    return { outcome: "skippedSandbox", reason: null, existingSubscriberId };
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
  };
}

// =============================================================
// planImport
// =============================================================

export async function planImport(jobId: string): Promise<ImportPlanSummary> {
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
  const seenTransactionKeys = new Set<string>();
  let totalRows = 0;
  const now = new Date();

  const reportWriter = createReportWriter(job.projectId, job.id);

  try {
    const objectStream: Readable = await importStore.getObject(job.storageKey);
    let header: string[] = [];

    for await (const event of parseCsvStream(objectStream)) {
      if ("header" in event) {
        header = event.header;
        continue;
      }
      totalRows += 1;

      const canonicalRow = buildCanonicalRow(header, event.row, mapping);

      const rawEntitlements = canonicalRow.entitlementIdentifiers?.trim();
      if (rawEntitlements) {
        const shape = classifyEntitlementShape(rawEntitlements);
        entitlementShapeCounts[shape] = (entitlementShapeCounts[shape] ?? 0) + 1;
      }

      const { outcome, reason, existingSubscriberId } = await classifyRow({
        db,
        projectId: job.projectId,
        canonicalRow,
        now,
        skipSandbox,
        seenTransactionKeys,
      });

      outcomes[outcome] += 1;

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
      reportWriter.writeReportRow(reportRow);
    }

    const reportStorageKey = await reportWriter.finalizeReport();

    await drizzle.importJobRepo.incrementImportJobCounters(db, job.projectId, job.id, outcomes);
    await drizzle.importJobRepo.setImportJobStatus(db, job.projectId, job.id, {
      status: "DRY_RUN_COMPLETE",
      reportStorageKey,
      finishedAt: new Date(),
    });

    return {
      jobId: job.id,
      totalRows,
      outcomes,
      entitlementShapeCounts,
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
