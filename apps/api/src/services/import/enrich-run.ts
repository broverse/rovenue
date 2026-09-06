// Google purchase-token second pass — the run.
//
// `enrich.ts` decides which purchase rows a token belongs to and writes
// nothing. THIS module is the thing that acts on those decisions: it
// reads a GOOGLE_TOKEN_ENRICHMENT job's file, resolves every
// (subscriber, product) pair, streams a report, persists counters, and —
// on a commit run only — writes `purchases.googlePurchaseToken` and
// hands the newly enriched chains to Phase B.
//
// -------------------------------------------------------------
// One pass, two modes — deliberately not two functions
// -------------------------------------------------------------
//
// The history importer has TWO classifiers: plan.ts (dry run) and
// write.ts (commit), kept in agreement by hand and by a comment asking
// the next editor to keep them that way. That is a standing hazard: a
// dry run whose buckets no longer describe what the commit will do is
// worse than no dry run, because the operator approved a plan that is
// not the one being executed.
//
// This pass does not repeat it. `runEnrichmentJob` IS the classifier,
// and `mode` only decides whether the resolved answer is written. A dry
// run therefore cannot report a different set from the commit that
// follows it — the same code produced both.
//
// -------------------------------------------------------------
// What is held in memory, and why that is safe here
// -------------------------------------------------------------
//
// Unlike plan.ts (which streams and never accumulates), this pass MUST
// group the whole file before it can resolve anything: "the file gives
// this pair exactly one token" is a property of the file, invisible from
// any single row (see enrich.ts's own comment). So the pair map is
// resident for the run.
//
// That is proportionate. An enrichment file is the three-column token
// file RevenueCat support hand-delivers — one row per Android
// subscription, not one row per transaction — so its pair count is
// bounded by a project's Android subscriber count, orders of magnitude
// below the multi-gigabyte Transactions export report.ts's streaming
// rules were written for. Row-level OUTCOMES are still never
// accumulated: they go straight to the NDJSON report as each pair
// resolves.
import type { Readable } from "node:stream";
import { drizzle, type Db, type ImportJobOptions } from "@rovenue/db";
import {
  normalizeEnrichmentRow,
  parseCsvStream,
  type CanonicalField,
  type EnrichmentRow,
} from "@rovenue/shared";
import * as importStore from "../../lib/import-store";
import { logger } from "../../lib/logger";
import {
  groupEnrichmentRowsByPair,
  resolveEnrichmentTarget,
  type EnrichmentPair,
  type EnrichmentResolution,
} from "./enrich";
import { buildCanonicalRow } from "./plan";
import {
  ENRICHMENT_OUTCOMES,
  buildDryRunCounters,
  createReportWriter,
  emptyOutcomeCounters,
  type EnrichmentOutcome,
  type ReportRow,
  type ReportWriter,
} from "./report";
import { auditImportRunCompleted } from "./write";
import {
  verifyEnrichedGoogleAnchors,
  type EnrichedGoogleChain,
  type ImportVerifyDeps,
} from "./verify";
import { createProductionImportVerifyDeps } from "./verify-store-clients";

const log = logger.child("import-enrich-run");

/** How often (at most) the run re-reads its own job row to notice an
 *  operator's Cancel. Same wall-clock cadence, for the same reason, as
 *  plan.ts's `DRY_RUN_CANCELLATION_CHECK_INTERVAL_MS` and verify.ts's
 *  `CANCELLATION_CHECK_INTERVAL_MS`. */
const CANCELLATION_CHECK_INTERVAL_MS = 2_000;

/**
 * Auxiliary counter keys, deliberately OUTSIDE the outcome-bucket
 * namespace (same separation verify.ts's `verifyAnchor*` keys use).
 *
 * The outcome buckets count SOURCE ROWS, because that is what a job's
 * counters have always described and what a report line corresponds to.
 * But the unit an operator actually cares about here is purchase rows —
 * one enrichment row can patch a whole renewal chain — and "3 rows
 * enriched" vs "3 subscriptions enriched" is the difference between a
 * believable dry run and a confusing one. Neither number can be derived
 * from the other, so both are persisted.
 */
const ENRICHMENT_COUNTER_KEYS = {
  /** Purchase rows the run wrote (or, on a dry run, would write). */
  ENRICHED_PURCHASE_ROWS: "enrichedPurchaseRows",
  /** Purchase rows that `enrichUngroupedChains` would ADDITIONALLY
   *  enrich if the operator turned it on. Zero when no pair reported
   *  `ungroupedChains`; this is what makes that outcome actionable
   *  rather than merely alarming. */
  UNGROUPED_PURCHASE_ROWS: "ungroupedChainsPurchaseRows",
} as const;

export type EnrichmentRunMode = "DRY_RUN" | "COMMIT";

export interface EnrichmentRunResult {
  jobId: string;
  mode: EnrichmentRunMode;
  /** Terminal status this call left the job row in. */
  status: "DRY_RUN_COMPLETE" | "COMPLETED" | "CANCELLED" | "VERIFICATION_INCOMPLETE";
  /** Source rows read, header excluded. */
  totalRows: number;
  /** Distinct (subscriber, product) pairs the file described. */
  totalPairs: number;
  /** Complete, from-scratch counts for THIS call, over every enrichment
   *  bucket. Source-row counts — see `ENRICHMENT_COUNTER_KEYS`. */
  counters: Record<EnrichmentOutcome, number>;
  /** Purchase rows actually written (COMMIT) or that would be written
   *  (DRY_RUN). */
  enrichedPurchaseRows: number;
  /** Purchase rows `enrichUngroupedChains` would additionally reach. */
  ungroupedChainsPurchaseRows: number;
  reportStorageKey: string | null;
}

export interface RunEnrichmentJobOptions {
  mode: EnrichmentRunMode;
  /** Override for testing only — production gets
   *  `createProductionImportVerifyDeps()`. Same seam
   *  `RunImportJobOptions.verifyDeps` already provides for the history
   *  runner: a test whose subject is the WRITE must not be reclassified
   *  VERIFICATION_INCOMPLETE purely because the test project has no Play
   *  credentials connected. Unused on a dry run, which never verifies. */
  verifyDeps?: ImportVerifyDeps;
  /** Override for testing only — production always gets the real,
   *  interval-paced DB status check below. The same seam plan.ts's
   *  `PlanImportOptions.isCancelled` and verify.ts's `deps.isCancelled`
   *  already provide: a test can prove a Cancel is noticed BETWEEN two
   *  specific pairs without waiting on real wall-clock time, and without
   *  racing the `RUNNING` write this function makes on entry (which
   *  would otherwise overwrite the very status the test set). */
  isCancelled?: () => Promise<boolean>;
}

/**
 * Human-readable detail for the report's `reason` column.
 *
 * Exhaustive over `EnrichmentResolution` — deliberately a `switch` with
 * no `default`, so a new outcome cannot ship with an empty reason
 * column. `invalidRow` is absent because the resolver never returns it:
 * that bucket is produced by the row gate in `readEnrichmentFile`, which
 * supplies its own reason from the gate's own error.
 *
 * Every refusal names what would change it. `ungroupedChains` in
 * particular names the option BY ITS EXACT KEY: it is settable only
 * through `PATCH .../mapping`, has no other documentation reachable from
 * a report, and an operator who hits it across their whole file would
 * otherwise have no way to discover that the pass can be made to work.
 */
function reasonFor(resolution: EnrichmentResolution, pair: EnrichmentPair): string | null {
  switch (resolution.outcome) {
    case "enriched":
      return null;
    case "alreadyEnriched":
      return "already carries this token — nothing to write (a re-run of the same file is a no-op)";
    case "noMatch":
      return (
        `no PLAY_STORE purchase found for subscriber "${pair.subscriberExternalId}" and ` +
        `product "${pair.productIdentifier}" — check that the history import ran first, and ` +
        `that this product's Google store id is in the catalog`
      );
    case "ambiguousMatch":
      return resolution.reason === "MULTIPLE_SOURCE_TOKENS"
        ? `this file supplies ${resolution.tokenCount} different purchase tokens for the same ` +
            `subscriber and product — the file itself says these are two subscriptions, so no ` +
            `option can resolve it; split them or correct the export`
        : `spans ${resolution.chainCount} distinct subscription chains (a resubscribe after a ` +
            `lapse) — reported and skipped rather than guessed at, because stamping one ` +
            `subscription's token onto another's renewals would make verification confidently ` +
            `re-check the wrong subscription`;
    case "ungroupedChains":
      return (
        `${resolution.purchaseIds.length} purchase row(s) across ${resolution.chainCount} ` +
        `one-row chains — the history export carried no original-transaction column, so nothing ` +
        `links these renewals. Set the "enrichUngroupedChains" job option to treat them as one ` +
        `subscription and enrich them`
      );
    case "conflictingToken":
      return (
        `${resolution.purchaseIds.length} purchase row(s) already store a DIFFERENT purchase ` +
        `token — never overwritten. Resolve which token is correct before re-running`
      );
  }
}

/**
 * Reads the whole file once: buckets rows the enrichment gate rejects,
 * and groups the rest into pairs.
 *
 * `invalidRow` is reported here, per SOURCE LINE, rather than folded
 * into the pair layer — a row missing one of the three required fields
 * has no pair to belong to, and the operator needs the line number.
 *
 * The rows handed to `groupEnrichmentRowsByPair` are the NORMALIZED
 * ones (trimmed, all three fields proven present), never the raw
 * canonical row: `"user_1 "` and `"user_1"` must be the same pair, and
 * a pair key built from untrimmed cells would split them and then
 * report both halves as unmatched.
 */
async function readEnrichmentFile(args: {
  objectStream: Readable;
  mapping: Record<string, CanonicalField>;
  onInvalidRow: (row: ReportRow) => Promise<void>;
}): Promise<{ totalRows: number; invalidRows: number; pairs: EnrichmentPair[] }> {
  const { objectStream, mapping, onInvalidRow } = args;
  const valid: { lineNumber: number; row: EnrichmentRow }[] = [];
  let header: string[] = [];
  let totalRows = 0;
  let invalidRows = 0;

  for await (const event of parseCsvStream(objectStream)) {
    if ("header" in event) {
      header = event.header;
      continue;
    }
    totalRows += 1;
    const canonicalRow = buildCanonicalRow(header, event.row, mapping);
    const normalized = normalizeEnrichmentRow(canonicalRow);
    if (!normalized.ok) {
      invalidRows += 1;
      await onInvalidRow({
        lineNumber: event.lineNumber,
        outcome: "invalidRow",
        subscriberExternalId: canonicalRow.subscriberExternalId ?? null,
        existingSubscriberId: null,
        // An enrichment file has no store or transaction-id column at
        // all — reporting null is the honest answer, not a gap.
        store: null,
        productIdentifier: canonicalRow.productIdentifier ?? null,
        storeTransactionId: null,
        reason: `${normalized.error.code}: ${normalized.error.field}`,
      });
      continue;
    }
    valid.push({ lineNumber: event.lineNumber, row: normalized.row });
  }

  return { totalRows, invalidRows, pairs: groupEnrichmentRowsByPair(valid) };
}

/**
 * Applies one resolved pair, or refuses it.
 *
 * THE GATE IS THE OUTCOME NAME, NOT THE PAYLOAD. `ungroupedChains`
 * carries `purchaseIds` describing exactly what turning the opt-in ON
 * would enrich, purely so a dry run can quantify the offer; a writer
 * that treated "has purchaseIds" as "write these" would write precisely
 * the set the option exists to gate, silently defeating it. So does
 * `conflictingToken`, whose ids are the rows that must NOT be touched.
 * Only `enriched` writes.
 */
async function applyResolution(args: {
  db: Db;
  projectId: string;
  pair: EnrichmentPair;
  resolution: EnrichmentResolution;
}): Promise<{ written: { id: string; storeTransactionId: string }[] }> {
  const { db, projectId, pair, resolution } = args;
  if (resolution.outcome !== "enriched") return { written: [] };

  const token = pair.tokens[0]!;
  const written = await db.transaction(async (tx) =>
    drizzle.purchaseRepo.enrichGooglePurchaseTokens(tx, {
      projectId,
      purchaseIds: resolution.purchaseIds,
      googlePurchaseToken: token,
    }),
  );

  if (written.length !== resolution.purchaseIds.length) {
    // The repository's own predicates (soft-deleted subscriber, a
    // differing stored token, a non-Play row) refused rows the resolver
    // had cleared — the two reads are not in the same transaction, so
    // this is a real, if rare, race rather than an impossible state. It
    // is a partial success, not a failure: the rows that DID write are
    // correct. Logged with both counts so it is diagnosable instead of
    // being invisible in a matching-looking counter.
    log.warn("enrichment: fewer purchase rows written than resolved", {
      projectId,
      subscriberExternalId: pair.subscriberExternalId,
      productIdentifier: pair.productIdentifier,
      resolved: resolution.purchaseIds.length,
      written: written.length,
    });
  }
  return { written };
}

/**
 * Runs one GOOGLE_TOKEN_ENRICHMENT job, in dry-run or commit mode.
 *
 * Idempotent: a second commit of the same file resolves every pair to
 * `alreadyEnriched` and writes nothing, because the resolver compares
 * the file's token against the one already stored.
 */
export async function runEnrichmentJob(
  jobId: string,
  options: RunEnrichmentJobOptions,
): Promise<EnrichmentRunResult> {
  const db = drizzle.db;
  const { mode } = options;
  const job = await drizzle.importJobRepo.getImportJobById(db, jobId);
  if (!job) {
    throw new Error(`runEnrichmentJob: import job ${jobId} not found`);
  }
  // Mirror of `planImport`'s guard: a HISTORY file run through this pass
  // would report `invalidRow` for every line (no googlePurchaseToken
  // column mapped) — a confident, wrong answer. Fail loudly instead.
  if (job.kind !== "GOOGLE_TOKEN_ENRICHMENT") {
    throw new Error(
      `runEnrichmentJob: job ${jobId} has kind ${job.kind} — only GOOGLE_TOKEN_ENRICHMENT jobs run here`,
    );
  }

  const projectId = job.projectId;
  const mapping = job.mapping as Record<string, CanonicalField>;
  const jobOptions = job.options as ImportJobOptions;

  await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
    status: mode === "DRY_RUN" ? "DRY_RUN_RUNNING" : "RUNNING",
    startedAt: job.startedAt ?? new Date(),
  });

  // A dry run overwrites the single report object (one complete scan, no
  // crash-resume concern); a commit takes its own numbered PART, the
  // same rule Phase A follows so a re-run can never destroy the previous
  // attempt's record of why a pair was refused.
  const reportPartNumber = mode === "COMMIT" ? job.reportPartCount + 1 : undefined;
  const reportWriter: ReportWriter = createReportWriter(projectId, jobId, reportPartNumber);

  const counters = emptyOutcomeCounters(ENRICHMENT_OUTCOMES);
  let enrichedPurchaseRows = 0;
  let ungroupedChainsPurchaseRows = 0;
  const enrichedChains: EnrichedGoogleChain[] = [];
  let cancelled = false;
  let lastCancelCheckAt = 0;

  try {
    const objectStream = await importStore.getObject(job.storageKey);
    const { totalRows, invalidRows, pairs } = await readEnrichmentFile({
      objectStream,
      mapping,
      onInvalidRow: (row) => reportWriter.writeReportRow(row),
    });
    counters.invalidRow = invalidRows;

    for (const pair of pairs) {
      // Cancellation is checked BETWEEN pairs, on a wall-clock cadence
      // (plan.ts and verify.ts both do the same, for the same reason:
      // one DB round trip per unit of work is too expensive, and a pair
      // is the smallest unit that can be abandoned coherently — its
      // write is a single statement).
      //
      // Without this the run would notice nothing and then write
      // DRY_RUN_COMPLETE / VERIFYING straight over the operator's
      // CANCELLED, which is exactly the bug plan.ts's own late "the
      // still-running scan clobbered it" fix describes. Already-written
      // tokens are left in place: every write here is idempotent, so a
      // re-run simply resolves them as `alreadyEnriched`.
      if (options.isCancelled) {
        if (await options.isCancelled()) {
          cancelled = true;
          break;
        }
      } else {
        const nowMs = Date.now();
        if (nowMs - lastCancelCheckAt >= CANCELLATION_CHECK_INTERVAL_MS) {
          lastCancelCheckAt = nowMs;
          const fresh = await drizzle.importJobRepo.getImportJob(db, projectId, jobId);
          if (fresh?.status === "CANCELLED") {
            cancelled = true;
            break;
          }
        }
      }

      const resolution = await resolveEnrichmentTarget({
        db,
        projectId,
        pair,
        options: jobOptions,
      });
      // Source rows, not pairs: a pair the file repeated on three lines
      // accounts for three rows, so the buckets always sum to the file's
      // row count and a report line always has a bucket.
      counters[resolution.outcome] += pair.lineNumbers.length;

      if (resolution.outcome === "ungroupedChains") {
        ungroupedChainsPurchaseRows += resolution.purchaseIds.length;
      }

      if (mode === "COMMIT") {
        const { written } = await applyResolution({ db, projectId, pair, resolution });
        enrichedPurchaseRows += written.length;
        if (written.length > 0) {
          enrichedChains.push({
            purchaseToken: pair.tokens[0]!,
            productIdentifier: pair.productIdentifier,
            storeTransactionIds: written.map((row) => row.storeTransactionId),
          });
        }
      } else if (resolution.outcome === "enriched") {
        enrichedPurchaseRows += resolution.purchaseIds.length;
      }

      // One report line per SOURCE line, so an operator can find the row
      // in their own file. Every line of a pair shares the pair's answer,
      // which is correct: the pair is the unit the decision was made on.
      const reason = reasonFor(resolution, pair);
      for (const lineNumber of pair.lineNumbers) {
        await reportWriter.writeReportRow({
          lineNumber,
          outcome: resolution.outcome,
          subscriberExternalId: pair.subscriberExternalId,
          existingSubscriberId: null,
          store: null,
          productIdentifier: pair.productIdentifier,
          storeTransactionId: null,
          reason,
        });
      }
    }

    const reportStorageKey = await reportWriter.finalizeReport();

    if (cancelled) {
      // The row is ALREADY `CANCELLED` — that is how this was detected —
      // so the status is deliberately left alone. The counters ARE
      // persisted: on a commit they describe token writes that really
      // happened, and hiding them would leave the operator unable to see
      // what the cancelled run had already done.
      await drizzle.importJobRepo.setImportJobCounters(db, projectId, jobId, {
        ...counters,
        [ENRICHMENT_COUNTER_KEYS.ENRICHED_PURCHASE_ROWS]: enrichedPurchaseRows,
        [ENRICHMENT_COUNTER_KEYS.UNGROUPED_PURCHASE_ROWS]: ungroupedChainsPurchaseRows,
      });
      log.info("enrichment job cancelled mid-run", { jobId, enrichedPurchaseRows });
      return {
        jobId,
        mode,
        status: "CANCELLED",
        totalRows,
        totalPairs: pairs.length,
        counters,
        enrichedPurchaseRows,
        ungroupedChainsPurchaseRows,
        reportStorageKey,
      };
    }

    if (mode === "DRY_RUN") {
      // Same overwrite-not-additive rule the history dry run uses, under
      // the same `dryRun_` prefix — a re-run after flipping
      // `enrichUngroupedChains` must REPLACE the previous attempt's
      // counts, not stack on them.
      await drizzle.importJobRepo.setImportJobCounters(db, projectId, jobId, {
        ...buildDryRunCounters(ENRICHMENT_OUTCOMES, counters),
        [ENRICHMENT_COUNTER_KEYS.ENRICHED_PURCHASE_ROWS]: enrichedPurchaseRows,
        [ENRICHMENT_COUNTER_KEYS.UNGROUPED_PURCHASE_ROWS]: ungroupedChainsPurchaseRows,
      });
      await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
        status: "DRY_RUN_COMPLETE",
        reportStorageKey,
        finishedAt: new Date(),
      });
      return {
        jobId,
        mode,
        status: "DRY_RUN_COMPLETE",
        totalRows,
        totalPairs: pairs.length,
        counters,
        enrichedPurchaseRows,
        ungroupedChainsPurchaseRows,
        reportStorageKey,
      };
    }

    // COMMIT. Unlike the history runner this pass is not checkpointed by
    // line — it reads the whole (small) file in one go and every write
    // it makes is idempotent, so a crashed run is simply re-run from the
    // start and re-resolves every pair to `alreadyEnriched`. Counters are
    // therefore SET, not incremented: a second attempt's complete counts
    // replace the first's rather than doubling them.
    await drizzle.importJobRepo.setImportJobCounters(db, projectId, jobId, {
      ...counters,
      [ENRICHMENT_COUNTER_KEYS.ENRICHED_PURCHASE_ROWS]: enrichedPurchaseRows,
      [ENRICHMENT_COUNTER_KEYS.UNGROUPED_PURCHASE_ROWS]: ungroupedChainsPurchaseRows,
    });
    await drizzle.importJobRepo.setImportJobStatus(db, projectId, jobId, {
      status: "VERIFYING",
      reportPartCount: reportPartNumber!,
    });

    // Phase B. The rows this pass just stamped were written by an
    // earlier history import as `androidNoToken` — persisted with
    // `verifiedAt` null and skipped by that job's Phase B because there
    // was no token to check. Handing the new tokens straight to the same
    // verification machinery is what turns them into live entitlements;
    // without it this pass would write a column nothing reads.
    //
    // Its own try/catch, for the same reason Phase A has one: a broken
    // verifier must never relabel writes that already succeeded as
    // FAILED. The worst it can do is leave the job resumable at
    // VERIFICATION_INCOMPLETE.
    let status: EnrichmentRunResult["status"] = "COMPLETED";
    try {
      const summary = await verifyEnrichedGoogleAnchors(
        jobId,
        options.verifyDeps ?? createProductionImportVerifyDeps(),
        enrichedChains,
      );
      if (summary.status !== "COMPLETED") status = summary.status;
    } catch (verifyErr) {
      log.error(
        "enrichment: phase B verification crashed (the token writes already succeeded)",
        {
          jobId,
          err: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        },
      );
      status = "VERIFICATION_INCOMPLETE";
      await drizzle.importJobRepo
        .setImportJobStatus(db, projectId, jobId, { status: "VERIFICATION_INCOMPLETE" })
        .catch(() => undefined);
    }

    // The run's TRUE final status goes into the append-only, hash-chained
    // audit log — never an unconditional "COMPLETED". Same function and
    // same `import.completed` action the history runner uses: one audit
    // vocabulary for one table, with the job row's `kind` and the
    // enrichment-only counter keys in the payload saying which pass it was.
    await auditImportRunCompleted(jobId, counters, status);

    return {
      jobId,
      mode,
      status,
      totalRows,
      totalPairs: pairs.length,
      counters,
      enrichedPurchaseRows,
      ungroupedChainsPurchaseRows,
      reportStorageKey,
    };
  } catch (err) {
    await reportWriter.finalizeReport().catch(() => undefined);
    await drizzle.importJobRepo
      .setImportJobStatus(db, projectId, jobId, {
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        ...(reportPartNumber !== undefined ? { reportPartCount: reportPartNumber } : {}),
      })
      .catch(() => undefined);
    throw err;
  }
}
