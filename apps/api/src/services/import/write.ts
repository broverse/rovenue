// Phase A writer for the data-import tool (spec §4.5).
//
// This is the first module in the import pipeline that writes customer
// data. Everything before it (parser, mapping, normalizer, key builders,
// dry-run planner) was a rehearsal that touched nothing.
//
// The five rules below are requirements, not style preferences. Each one
// traces to a specific way a bulk history import can damage a real
// customer's production project, and each is asserted by a test in
// tests/services/import-write.integration.test.ts:
//
//  1. NEVER emit a `SUBSCRIPTION`-aggregate outbox row and NEVER enqueue
//     an outgoing webhook. Both are emitted exclusively by
//     `runPostProcessing` (services/webhook-processor.ts), which drives
//     third-party integration fan-out (Meta/TikTok/Braze/…) AND the
//     customer's own webhook endpoints. A writer routed through that path
//     would blast two years of backdated purchase events at a customer's
//     live integrations the moment they migrated. This module is modelled
//     on services/receipt-verify.ts, which writes purchases, subscribers
//     and access without touching either.
//  2. DO create revenue events — that is the only way imported history
//     reaches ClickHouse analytics — always with a dedupe key derived
//     ONLY from the source transaction (`buildRevenueDedupeKey`). The key
//     must never contain the import-job id: a job id there doubles a
//     customer's lifetime revenue on their second attempt.
//     `createRevenueEvent` writes its own REVENUE_EVENT outbox row
//     internally; that is expected and correct.
//  3. Resolve subscribers through the merge-chain-following resolver, so
//     writes land on the surviving row rather than one that was merged
//     away by `/v1/subscribers/transfer`.
//  4. One audit entry per import JOB, never per row (`import.started` is
//     written by the upload route; `auditImportRunCompleted` below closes
//     the pair once, for the whole run).
//  5. NEVER write `subscriber_access` directly — call `syncAccess`, which
//     recomputes access from live purchases under a per-subscriber
//     advisory lock.
//  6. NEVER set `subscribers.platform`. It is SDK first-install truth and
//     is deliberately not purchase-derived; leaving it unset is correct.
import { drizzle, type Db, type Purchase, type Subscriber } from "@rovenue/db";
import {
  normalizeRow,
  type CanonicalRow,
  type NormalizedRow,
} from "@rovenue/shared";
import {
  buildRevenueDedupeKey,
  buildSyntheticTransactionId,
} from "@rovenue/shared/import/keys";
import { audit } from "../../lib/audit";
import { resolveSubscriberForWrite } from "../../lib/resolve-or-create-subscriber";
import { syncAccess } from "../access-engine";
import { resolveProduct } from "./plan";
import { IMPORT_OUTCOMES, type ImportOutcome, type ReportRow } from "./report";

// =============================================================
// Options + constants
// =============================================================

/** Sandbox rows are noise in almost every migration, so the importer
 *  drops them unless the operator explicitly asks for them. Same default
 *  the dry-run planner uses, so the report the operator approved matches
 *  what the run does. */
const DEFAULT_SKIP_SANDBOX = true;

/** Anchorless (RevenueCat `promotional`) rows ARE imported by default:
 *  they are real complimentary grants a customer's users hold today, and
 *  dropping them silently would revoke access on migration day. The
 *  operator can opt out per job. */
const DEFAULT_IMPORT_ANCHORLESS = true;

/** `purchases.environment` is NOT NULL and has no "unknown" member; the
 *  source row's sandbox flag is the only signal an export carries. */
const ENVIRONMENT_PRODUCTION = "PRODUCTION";
const ENVIRONMENT_SANDBOX = "SANDBOX";

/** A `renewal_number` at or below this is not evidence of a renewal.
 *  RevenueCat's own numbering for the first transaction of a
 *  subscription is not confirmed by our research, so the value is used
 *  only where it is unambiguous — strictly greater than this means the
 *  row is definitely not the first transaction. */
const FIRST_RENEWAL_NUMBER = 1;

// =============================================================
// Public shape
// =============================================================

/** One row handed to the writer: the canonical row (already rewritten
 *  onto canonical field names by the job's mapping) plus its line number
 *  in the source file, which is what the report and Task 8's checkpoint
 *  are keyed on. */
export type ImportWriteRow = {
  lineNumber: number;
  row: CanonicalRow;
};

/**
 * Result of writing one batch.
 *
 * `outcomes` reuses the dry run's bucket vocabulary (report.ts's
 * `IMPORT_OUTCOMES`) so a job's counters speak one language end to end,
 * with three writer-specific readings:
 *   - `willCreate` / `willUpdate` mean "did create" / "did update" — the
 *     tense is the dry run's, the meaning here is past.
 *   - `anchorless` counts anchorless rows the job SKIPPED because
 *     `options.importAnchorless` is false. An anchorless row that is
 *     imported is counted as the create/update it actually performed.
 *   - `androidNoToken` (final-fix-wave FIX 2) is UNLIKE `anchorless`: it
 *     always means "written, but as history only" — the purchase and its
 *     revenue event ARE created/updated (same as willCreate/willUpdate),
 *     just with `verifiedAt` left null and excluded from Phase B, because
 *     a PLAY_STORE row with no Google purchase token can never be
 *     re-verified against the store. It is never a skip.
 *   - `duplicateInFile` is never produced: a repeated
 *     (store, storeTransactionId) within one file resolves to the same
 *     upsert target, so the second occurrence is a redundant write, not a
 *     distinct outcome.
 *
 * The batch does NOT persist its own counters or checkpoint — Task 8's
 * worker owns both, because only it knows whether a batch was replayed
 * after a crash.
 */
export type BatchOutcome = {
  jobId: string;
  projectId: string;
  outcomes: Record<ImportOutcome, number>;
  /** Highest source line number seen in this batch, or 0 for an empty
   *  batch — the value Task 8 checkpoints once the batch commits. */
  lastLineNumber: number;
  /** One report line per input row, bounded by the batch size (never by
   *  the file size). The caller streams these to the report artefact. */
  reportRows: ReportRow[];
  /** Subscribers whose `subscriber_access` was recomputed by this batch. */
  syncedSubscriberIds: string[];
};

// =============================================================
// Row-level decisions
// =============================================================

/**
 * Revenue-event type for an imported transaction, mirroring
 * receipt-verify.ts's convention (a transaction whose id differs from its
 * original transaction id is a renewal) and falling back to the source's
 * renewal counter only where that counter is unambiguous.
 */
function deriveRevenueEventType(
  normalized: NormalizedRow,
  storeTransactionId: string,
): "INITIAL" | "RENEWAL" {
  if (
    normalized.originalTransactionId &&
    normalized.originalTransactionId !== storeTransactionId
  ) {
    return "RENEWAL";
  }
  const renewalNumber = Number(normalized.renewalNumber);
  if (Number.isFinite(renewalNumber) && renewalNumber > FIRST_RENEWAL_NUMBER) {
    return "RENEWAL";
  }
  return "INITIAL";
}

/**
 * Whether this row contributes a revenue event at all.
 *
 * Refunded rows deliberately contribute NOTHING, and that is the one
 * place this importer knowingly drops money from analytics. The reason is
 * structural: `buildRevenueDedupeKey` (Task 3, spec §4.5) keys on
 * (store, storeTransactionId, renewalNumber) with no "kind" component, so
 * one source row can mint exactly ONE revenue event — a payment/refund
 * pair is not representable. And a lone REFUND row is actively wrong:
 * ClickHouse computes `net = gross - refunds` with REFUND excluded from
 * gross (packages/db/clickhouse/migrations/0012 and 0014), so importing a
 * refunded transaction as a REFUND alone would push a customer's net
 * revenue NEGATIVE. Contributing neither the payment nor the refund
 * leaves net exactly where a paid-then-refunded transaction belongs: at
 * zero.
 *
 * Family-shared rows are excluded for the reason the normalizer already
 * recorded on `excludeFromRevenue`: they are shared access, not a sale.
 */
function shouldRecordRevenue(normalized: NormalizedRow): boolean {
  if (normalized.refundedAt) return false;
  if (normalized.excludeFromRevenue) return false;
  return normalized.priceAmount !== null && normalized.priceCurrency !== null;
}

/**
 * The natural key this row's purchase is written under.
 *
 * Carry-forward (Task 3, fix 4c): a `promotional` row may carry a REAL
 * store transaction id. When it does, that value is preserved — it is the
 * only value that could later match a store webhook — and no synthetic id
 * is minted over it. A synthetic id is minted only when the source row
 * genuinely carried none, and it is derived deterministically from the
 * row's own identity so a re-run resolves to the SAME purchase instead of
 * creating a fresh MANUAL grant every time.
 *
 * `buildSyntheticTransactionId` needs `projectId`, which the pure
 * normalizer deliberately does not have — which is why this call lives in
 * the writer rather than in normalizeRow.
 *
 * Exported for Task 9 (services/import/verify.ts): Phase B re-parses the
 * same source file to discover which store anchors need re-verification,
 * and must land on the SAME storeTransactionId this writer used, or its
 * `findPurchaseByStoreTransaction` / `updatePurchase*` calls would miss
 * the row (or worse, a synthetic id computed differently would look like
 * a second purchase). One implementation, never two.
 */
export function resolveStoreTransactionId(
  projectId: string,
  normalized: NormalizedRow,
): string {
  if (normalized.storeTransactionId) return normalized.storeTransactionId;
  return buildSyntheticTransactionId({
    projectId,
    subscriberExternalId: normalized.subscriberExternalId,
    productIdentifier: normalized.productIdentifier,
    purchaseDateIso: normalized.purchaseDate.toISOString(),
  });
}

// =============================================================
// Subscriber resolution (rule 3)
// =============================================================

type SubscriberResolution =
  | { kind: "resolved"; subscriber: Subscriber }
  | { kind: "deadEnded" };

/**
 * Resolves the live subscriber an imported row belongs to, creating one
 * only when the identity is entirely unknown.
 *
 * Same rovenueId-first-then-legacy-appUserId order the dry run reported
 * `existingSubscriberId` with, so the writer lands on the row the report
 * named instead of inventing a second one for the same person — but with
 * every branch forced through the merge chain:
 *
 *  1. `resolveSubscriberByRovenueId` follows `mergedInto` redirects and
 *     returns null for a dead end.
 *  2. The legacy `appUserId` fallback needs its own guard:
 *     `findSubscriberByAppUserId` does NOT filter `deletedAt` (the
 *     partial unique index does, the finder doesn't), so a hit can be a
 *     row that `/v1/subscribers/transfer` retired. Writing onto it is
 *     precisely the fork rule 3 exists to prevent, so a soft-deleted hit
 *     is re-resolved through its own rovenueId and only its live
 *     survivor is written to.
 *  3. Anything still unresolved goes to `resolveSubscriberForWrite`, the
 *     shared SDK write-path resolver, which distinguishes "unknown
 *     identity" (create it) from "dead-ended" — a soft-deleted row with
 *     no live survivor, e.g. a GDPR-erased subscriber. Writing purchases
 *     onto an erased identity would re-populate it, so those rows are
 *     refused rather than written.
 */
async function resolveSubscriberForImport(
  db: Db,
  projectId: string,
  subscriberExternalId: string,
): Promise<SubscriberResolution> {
  const byRovenueId = await drizzle.subscriberRepo.resolveSubscriberByRovenueId(
    db,
    { projectId, rovenueId: subscriberExternalId },
  );
  if (byRovenueId) return { kind: "resolved", subscriber: byRovenueId };

  const byAppUserId = await drizzle.subscriberRepo.findSubscriberByAppUserId(
    db,
    { projectId, appUserId: subscriberExternalId },
  );
  if (byAppUserId) {
    if (!byAppUserId.deletedAt) {
      return { kind: "resolved", subscriber: byAppUserId };
    }
    const survivor = await drizzle.subscriberRepo.resolveSubscriberByRovenueId(
      db,
      { projectId, rovenueId: byAppUserId.rovenueId },
    );
    return survivor
      ? { kind: "resolved", subscriber: survivor }
      : { kind: "deadEnded" };
  }

  const resolved = await resolveSubscriberForWrite(
    projectId,
    subscriberExternalId,
  );
  if (resolved.deadEnded) return { kind: "deadEnded" };
  return { kind: "resolved", subscriber: resolved.subscriber };
}

// =============================================================
// writeImportBatch
// =============================================================

function emptyOutcomes(): Record<ImportOutcome, number> {
  return Object.fromEntries(
    IMPORT_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<ImportOutcome, number>;
}

function reportRowFor(
  input: ImportWriteRow,
  outcome: ImportOutcome,
  reason: string | null,
  subscriberId: string | null,
): ReportRow {
  return {
    lineNumber: input.lineNumber,
    outcome,
    subscriberExternalId: input.row.subscriberExternalId ?? null,
    // For the writer this is the row the purchase was actually written
    // to — the post-merge survivor, not the identity the file named.
    existingSubscriberId: subscriberId,
    store: input.row.store ?? null,
    productIdentifier: input.row.productIdentifier ?? null,
    storeTransactionId: input.row.storeTransactionId ?? null,
    reason,
  };
}

/**
 * Writes one batch of already-mapped canonical rows for an import job.
 *
 * Bucket precedence mirrors the dry-run planner's (`classifyRow` in
 * plan.ts) exactly, so a row the operator saw reported as `willCreate` is
 * the row that gets created and a row reported as `unresolvedProduct` is
 * the row that gets skipped. Purchases land through `upsertPurchase`
 * (which CASE-guards terminal REFUNDED/REVOKED statuses at SQL level, so
 * re-importing a file that predates a refund cannot resurrect it), and
 * access is recomputed once per touched subscriber AFTER the purchases
 * commit.
 */
export async function writeImportBatch(
  jobId: string,
  rows: ImportWriteRow[],
): Promise<BatchOutcome> {
  const db = drizzle.db;
  const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
  if (!job) {
    throw new Error(`writeImportBatch: import job ${jobId} not found`);
  }

  const projectId = job.projectId;
  const skipSandbox = job.options?.skipSandbox ?? DEFAULT_SKIP_SANDBOX;
  const importAnchorless =
    job.options?.importAnchorless ?? DEFAULT_IMPORT_ANCHORLESS;

  const outcomes = emptyOutcomes();
  const reportRows: ReportRow[] = [];
  const touchedSubscriberIds = new Set<string>();
  const now = new Date();
  let lastLineNumber = 0;

  const record = (
    input: ImportWriteRow,
    outcome: ImportOutcome,
    reason: string | null = null,
    subscriberId: string | null = null,
  ): void => {
    outcomes[outcome] += 1;
    reportRows.push(reportRowFor(input, outcome, reason, subscriberId));
  };

  // -----------------------------------------------------------
  // Task 8a pre-flight: normalize every row FIRST — purely, with no I/O
  // — before this batch performs a single write. `revenue_events`
  // (migration 0015) is range-partitioned on `eventDate` with no
  // DEFAULT partition, so a row whose eventDate misses every existing
  // partition fails outright ("no partition of relation ... found for
  // row"). Provisioning the partitions this batch's rows need, BEFORE
  // the write loop below starts, is what turns that failure mode into
  // "the batch fails cleanly with nothing written" instead of "row
  // 400,000 dies mid-file after 399,999 rows already committed".
  //
  // The span covers every row that normalized successfully, not only
  // the subset that will actually record revenue: narrowing it further
  // would need each row's product resolved first (a DB round trip),
  // re-introducing the very cost this pure pre-pass exists to stay
  // ahead of. Over-provisioning an unused monthly partition is cheap
  // and was already the accepted trade-off in 0015's own bulk-create
  // ("safe to over-provision here"); silently under-provisioning is the
  // failure mode that actually matters.
  const normalizedRows = rows.map((input) => ({
    input,
    normalized: normalizeRow(input.row, { now }),
  }));

  let minEventDate: Date | null = null;
  let maxEventDate: Date | null = null;
  for (const { normalized } of normalizedRows) {
    if ("error" in normalized) continue;
    const eventDate = normalized.purchaseDate;
    if (minEventDate === null || eventDate.getTime() < minEventDate.getTime()) {
      minEventDate = eventDate;
    }
    if (maxEventDate === null || eventDate.getTime() > maxEventDate.getTime()) {
      maxEventDate = eventDate;
    }
  }
  if (minEventDate !== null && maxEventDate !== null) {
    // Deliberately NOT wrapped in try/catch: a provisioning failure
    // must propagate and abort the whole batch before the loop below
    // runs — that IS "failing cleanly", not a condition to recover
    // from here.
    await drizzle.revenueEventPartitionRepo.ensureRevenueEventPartitions(db, {
      minEventDate,
      maxEventDate,
    });
  }

  for (const { input, normalized } of normalizedRows) {
    lastLineNumber = Math.max(lastLineNumber, input.lineNumber);

    if ("error" in normalized) {
      record(input, "invalidRow", normalized.error.message);
      continue;
    }

    const productResolution = await resolveProduct(
      db,
      projectId,
      normalized.store,
      normalized.productIdentifier,
    );
    if (productResolution.kind !== "resolved") {
      const reason =
        productResolution.kind === "ambiguous"
          ? `product ambiguous: product identifier "${normalized.productIdentifier}" matches ${productResolution.matchCount} catalog products`
          : `product not found: no catalog product matches product identifier "${normalized.productIdentifier}"`;
      record(input, "unresolvedProduct", reason);
      continue;
    }
    const product = productResolution.product;

    if (normalized.isAnchorless && !importAnchorless) {
      record(input, "anchorless", "job opted out of importing anchorless rows");
      continue;
    }

    // Final-fix-wave FIX 2: a PLAY_STORE row with no Google purchase
    // token used to `continue` here — writing NEITHER a purchase NOR a
    // revenue event. RevenueCat's standard export has no
    // `google_purchase_token` column, so on the flagship input that
    // dropped 100% of Android history: purchases, revenue, LTV, cohorts.
    // Spec §4.2's whole bet is "every accepted row becomes a purchases
    // row… nothing is dropped merely because the store no longer
    // recognises it" — this row IS accepted (the mapping produced a
    // valid, non-anchorless row); a missing token only means Phase B has
    // nothing to re-verify it against, not that the row's history is
    // fictional. So it is written exactly like any other row below, with
    // `verifiedAt` left null (Phase A never contacts a store for ANY
    // row — this is not a special case), and counted in the
    // `androidNoToken` bucket instead of willCreate/willUpdate so the
    // operator can still see how many rows have no live entitlement.
    // verify.ts's Phase A rescan (`groups.get`/anchor discovery) still
    // skips PLAY_STORE-no-token rows on its own — there is no anchor to
    // verify without a token — so this does not add these rows to
    // Phase B.
    const isAndroidNoToken =
      normalized.store === "PLAY_STORE" && !normalized.googlePurchaseToken;

    if (normalized.isSandbox && skipSandbox) {
      record(input, "skippedSandbox");
      continue;
    }

    const subscriberResolution = await resolveSubscriberForImport(
      db,
      projectId,
      normalized.subscriberExternalId,
    );
    if (subscriberResolution.kind === "deadEnded") {
      record(
        input,
        "invalidRow",
        `subscriber "${normalized.subscriberExternalId}" resolves to an erased identity with no live survivor — refusing to re-populate it`,
      );
      continue;
    }
    const subscriber = subscriberResolution.subscriber;

    const storeTransactionId = resolveStoreTransactionId(projectId, normalized);

    // Read before the upsert purely so the outcome can say which of the
    // two things actually happened. Task 8 runs one job per project at a
    // time (IMPORT_JOB_CONCURRENCY_PER_PROJECT = 1), so this read and the
    // upsert cannot interleave with another batch of the same file; the
    // worst a live store webhook landing in between could do is mislabel
    // a create as an update in the report, never write the wrong row.
    const existingPurchase: Purchase | null =
      await drizzle.purchaseRepo.findPurchaseByStoreTransaction(
        db,
        normalized.store,
        storeTransactionId,
      );

    const environment = normalized.isSandbox
      ? ENVIRONMENT_SANDBOX
      : ENVIRONMENT_PRODUCTION;

    const purchase = await drizzle.purchaseRepo.upsertPurchase(db, {
      store: normalized.store,
      storeTransactionId,
      create: {
        projectId,
        subscriberId: subscriber.id,
        productId: product.id,
        store: normalized.store,
        storeTransactionId,
        // Carry-forward (Task 3): `purchases.originalTransactionId` is
        // NOT NULL and RevenueCat's Transactions export has no such
        // column, so this is null on EVERY row from the primary preset —
        // not just anchorless ones. grant.ts sets
        // `originalTransactionId = storeTransactionId` for a MANUAL
        // grant with no store anchor; the same substitution is made here,
        // deliberately, rather than discovering the constraint on row 1.
        originalTransactionId:
          normalized.originalTransactionId ?? storeTransactionId,
        status: normalized.status,
        isTrial: normalized.isTrial,
        isIntroOffer: normalized.isIntroOffer,
        isSandbox: normalized.isSandbox,
        environment,
        purchaseDate: normalized.purchaseDate,
        // No separate original-purchase-date in the source contract; the
        // column is NOT NULL, and the row's own purchase date is the only
        // truthful value available.
        originalPurchaseDate: normalized.purchaseDate,
        expiresDate: normalized.expiresDate,
        priceAmount: normalized.priceAmount,
        priceCurrency: normalized.priceCurrency,
        autoRenewStatus: normalized.autoRenewStatus,
        cancellationDate: normalized.cancellationDate,
        refundDate: normalized.refundedAt,
        gracePeriodExpires: normalized.gracePeriodEndDate,
        ownershipType: normalized.ownershipType,
        // Phase A never contacts a store. Task 9's verifier is what sets
        // this, and only for rows it actually confirmed.
        verifiedAt: null,
      },
      update: {
        // Guarded by upsertPurchase's SQL-level CASE: a REFUNDED/REVOKED
        // row keeps its terminal status even when an older export says
        // ACTIVE. Non-status fields still refresh.
        status: normalized.status,
        expiresDate: normalized.expiresDate,
        isTrial: normalized.isTrial,
        autoRenewStatus: normalized.autoRenewStatus,
        cancellationDate: normalized.cancellationDate,
        refundDate: normalized.refundedAt,
        gracePeriodExpires: normalized.gracePeriodEndDate,
        ...(normalized.priceAmount !== null && {
          priceAmount: normalized.priceAmount,
          priceCurrency: normalized.priceCurrency,
        }),
        ...(normalized.ownershipType !== null && {
          ownershipType: normalized.ownershipType,
        }),
        // `verifiedAt` is deliberately absent: an import must never clear
        // a verification a live store path already recorded on this row.
        updatedAt: new Date(),
      },
    });

    if (shouldRecordRevenue(normalized)) {
      await drizzle.revenueEventRepo.createRevenueEvent(db, {
        projectId,
        subscriberId: subscriber.id,
        purchaseId: purchase.id,
        productId: product.id,
        type: deriveRevenueEventType(normalized, storeTransactionId),
        amount: normalized.priceAmount!,
        currency: normalized.priceCurrency!,
        // `normalizeMoney` only ever produces a USD-denominated amount
        // (it reads `price_in_usd`), so no FX conversion is involved and
        // the two columns are the same number by construction.
        amountUsd: normalized.priceAmount!,
        store: normalized.store,
        eventDate: normalized.purchaseDate,
        dedupeKey: buildRevenueDedupeKey({
          store: normalized.store,
          storeTransactionId,
          renewalNumber: normalized.renewalNumber,
        }),
      });
    }

    touchedSubscriberIds.add(subscriber.id);
    record(
      input,
      isAndroidNoToken
        ? "androidNoToken"
        : existingPurchase
          ? "willUpdate"
          : "willCreate",
      isAndroidNoToken
        ? "PLAY_STORE row has no Google purchase token mapped — imported as history only, no live entitlement"
        : null,
      subscriber.id,
    );
  }

  // Rule 5: access is never written directly. syncAccess recomputes it
  // from the live purchases under a per-subscriber advisory lock, once
  // per touched subscriber rather than once per row — a subscriber with
  // 200 imported transactions is reconciled one time.
  for (const subscriberId of touchedSubscriberIds) {
    await syncAccess(subscriberId);
  }

  return {
    jobId: job.id,
    projectId,
    outcomes,
    lastLineNumber,
    reportRows,
    syncedSubscriberIds: [...touchedSubscriberIds],
  };
}

// =============================================================
// Job-level audit (rule 4)
// =============================================================

/**
 * Closes the job's audit pair with a single `import.completed` entry.
 *
 * Deliberately NOT part of `writeImportBatch`: that function runs once
 * per batch, so auditing inside it would produce one entry per batch —
 * the per-row-ish shape rule 4 forbids. `import.started` is written by
 * the upload route (routes/dashboard/imports.ts); this is its counterpart
 * and the run's caller (workers/import-runner.ts) invokes it exactly
 * once, when the whole run — Phase A AND Phase B — has settled.
 *
 * Task 10 fix round 1 (FIX 3): `status` is the run's TRUE final outcome
 * (`"COMPLETED" | "CANCELLED" | "VERIFICATION_INCOMPLETE"`), embedded in
 * the `after` payload alongside the Phase-A outcome buckets. Before this
 * fix, the caller invoked this function right after Phase A's own
 * `COMPLETED` write and BEFORE Phase B (store re-validation) ever ran —
 * so the append-only, hash-chained audit log could permanently record
 * `import.completed` for a run that went on to end
 * `VERIFICATION_INCOMPLETE`. `status` is typed as a plain string union
 * here, not imported from `workers/import-runner.ts`'s `ImportRunStatus`,
 * to avoid a circular import (that file imports THIS function) — the two
 * are kept structurally identical by convention, not by a shared type.
 * `outcomes` stays exactly what it always was: Phase-A's own outcome
 * buckets (`ImportOutcome`), never Phase-B's separately-namespaced verify
 * counters (see verify.ts's own module comment on why those never
 * collide with this key space) — only the terminal `status` needed to
 * become honest, not what this function considers "outcomes".
 */
export async function auditImportRunCompleted(
  jobId: string,
  outcomes: Record<ImportOutcome, number>,
  status: "COMPLETED" | "CANCELLED" | "VERIFICATION_INCOMPLETE",
): Promise<void> {
  const job = await drizzle.importJobRepo.getImportJobById(drizzle.db, jobId);
  if (!job) {
    throw new Error(`auditImportRunCompleted: import job ${jobId} not found`);
  }
  await audit({
    projectId: job.projectId,
    // Null when the operator who started the import has since been
    // removed from the project — the column is nullable for exactly this.
    userId: job.createdByUserId,
    action: "import.completed",
    resource: "import_job",
    resourceId: job.id,
    before: null,
    after: { ...outcomes, status },
    ipAddress: null,
    userAgent: null,
  });
}
