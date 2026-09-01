// Dry-run report artefact for the data-import tool (Task 6).
//
// Row-level outcomes are never accumulated in memory and never written to
// the `import_jobs` table (which holds only aggregate `counters` — see
// packages/db/src/drizzle/repositories/import-jobs.ts's module comment).
// Instead each row's outcome is streamed straight to object storage as it
// is decided, one NDJSON line at a time, through the same private import
// bucket the source upload lives in (`lib/import-store.ts`). A
// million-row file must never become a million-element array here.
import { PassThrough } from "node:stream";
import * as importStore from "../../lib/import-store";

// =============================================================
// Outcome buckets — closed list (plan.ts's Interfaces contract)
// =============================================================
//
// Every row the planner processes lands in EXACTLY ONE of these. See
// plan.ts's `classifyRow` for the precedence a row is checked in when it
// would otherwise fit more than one bucket — documented there, not here,
// because the precedence is a classification decision, not part of the
// bucket list's own contract.
export const IMPORT_OUTCOMES = [
  "willCreate",
  "willUpdate",
  "skippedSandbox",
  "unresolvedProduct",
  "anchorless",
  "androidNoToken",
  "invalidRow",
  "duplicateInFile",
] as const;

export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];

// =============================================================
// Dry-run counter namespace (final-fix-wave FIX 3)
// =============================================================
//
// plan.ts (the dry-run planner) and import-runner.ts (the commit run)
// both classify rows into these SAME eight outcome buckets — but they
// are two separate phases of a job's lifecycle, not one running total.
// Before this fix both persisted their counts into the SAME
// `import_jobs.counters` keys via `incrementImportJobCounters`, which is
// strictly additive: an ordinary dry-run-then-commit on N rows left
// `willCreate` reading ≈2N, permanently, in the append-only audit log
// too. A re-run of the dry run after a mapping fix compounded the same
// way on top of itself.
//
// The fix is structural, not a reset: the dry-run planner persists its
// counts under THIS prefixed key set (via `setImportJobCounters` —
// overwrite, not additive, since one dry-run attempt is always a
// complete, from-scratch scan) while the commit run keeps the plain
// `ImportOutcome` keys (via `incrementImportJobCounters`, additive
// across its own checkpointed batches/resumes, which is correct and
// unchanged). The two key sets can never collide, so there is no need to
// detect "is this a genuinely fresh run start" — a question that
// `checkpointLine` surviving a cancel-then-rerun cycle by design makes
// unreliable to answer on the commit side anyway.
const DRY_RUN_COUNTER_PREFIX = "dryRun_";

export function dryRunCounterKey(outcome: ImportOutcome): string {
  return `${DRY_RUN_COUNTER_PREFIX}${outcome}`;
}

/** Builds the full prefixed-key object `setImportJobCounters` persists
 *  for one dry-run attempt — always the complete, from-scratch count for
 *  every bucket, never a delta. */
export function buildDryRunCounters(
  outcomes: Record<ImportOutcome, number>,
): Record<string, number> {
  return Object.fromEntries(
    IMPORT_OUTCOMES.map((outcome) => [dryRunCounterKey(outcome), outcomes[outcome]]),
  );
}

/** Reverses `buildDryRunCounters` — reads the dry-run planner's own
 *  counts back out of a job's persisted `counters` object, defaulting an
 *  absent key to 0 (a job that has never had a dry run yet). */
export function readDryRunCounters(
  counters: Record<string, number>,
): Record<ImportOutcome, number> {
  return Object.fromEntries(
    IMPORT_OUTCOMES.map((outcome) => [outcome, counters[dryRunCounterKey(outcome)] ?? 0]),
  ) as Record<ImportOutcome, number>;
}

/** One line of the NDJSON report artefact. Deliberately narrow — enough
 *  for an operator to find and understand a flagged row in their own
 *  source file (line number + the identifying fields), not a full dump
 *  of every canonical field. */
export type ReportRow = {
  lineNumber: number;
  outcome: ImportOutcome;
  subscriberExternalId: string | null;
  /** The live subscriber this row resolves to today, via the SAME
   *  merge-chain-following resolver the real run will use
   *  (`resolveSubscriberByRovenueIdOrLegacy`), followed READ-ONLY — a dry
   *  run never creates or merges anything. Null when no subscriber
   *  exists yet for this identity (the real run would create one). Purely
   *  informational: it does not change which outcome bucket the row
   *  lands in. */
  existingSubscriberId: string | null;
  store: string | null;
  productIdentifier: string | null;
  storeTransactionId: string | null;
  /** Human-readable detail for a non-obvious outcome (a normalize error
   *  message, a duplicate's colliding key, an unresolved product's
   *  identifier). Null for outcomes that are self-explanatory
   *  (willCreate/willUpdate). */
  reason: string | null;
};

export interface ReportWriter {
  /**
   * Writes one line and resolves once the stream is ready for more.
   * `PassThrough.write()` returns `false` when its internal buffer is
   * full — ignoring that (fix round 1, minor 1) works today only because
   * the per-row DB round trips in `classifyRow` happen to throttle the
   * loop; a leaner caller (Task 8's writer) would otherwise let this
   * stream's buffer grow without bound, exactly the unbounded-memory
   * mistake this module exists to avoid for the rows themselves. Callers
   * MUST `await` this.
   */
  writeReportRow(row: ReportRow): Promise<void>;
  /** Ends the stream, waits for the upload to finish, and returns the
   *  storage key the finished report was written under. Calling
   *  `writeReportRow` after this throws — the stream is already closed. */
  finalizeReport(): Promise<string>;
}

/**
 * Opens a streaming NDJSON writer for one job's report artefact. The
 * returned `PassThrough` is handed to `importStore.putObject` immediately
 * (an S3 multipart `Upload`, same as the upload route's own streamed
 * write) so bytes flow to the bucket as `writeReportRow` produces them,
 * rather than being buffered here and written once at the end.
 *
 * `partNumber` is omitted by the dry-run planner (plan.ts), which keeps
 * writing the single, overwritable `buildReportStorageKey` object it
 * always has — a dry run is one synchronous call with no crash-resume
 * concern. The Phase-A writer (workers/import-runner.ts) always passes
 * one: each `runImportJob` attempt that does real work gets its own
 * immutable numbered part (`buildReportPartStorageKey`), which is what
 * makes a crash-and-resume unable to destroy an earlier attempt's report
 * (Task 8 fix round 1, FIX 5).
 */
export function createReportWriter(
  projectId: string,
  jobId: string,
  partNumber?: number,
): ReportWriter {
  const storageKey =
    partNumber === undefined
      ? importStore.buildReportStorageKey(projectId, jobId)
      : importStore.buildReportPartStorageKey(projectId, jobId, partNumber);
  const stream = new PassThrough();
  const uploadDone = importStore.putObject(storageKey, stream, "application/x-ndjson");
  let finalized = false;

  return {
    writeReportRow(row) {
      if (finalized) {
        throw new Error("createReportWriter: writeReportRow called after finalizeReport");
      }
      const canWriteMore = stream.write(`${JSON.stringify(row)}\n`);
      if (canWriteMore) {
        return Promise.resolve();
      }
      // Backpressure: the internal buffer is full. Wait for Node to drain
      // it to the underlying S3 Upload before accepting the next row.
      return new Promise((resolve) => stream.once("drain", resolve));
    },
    async finalizeReport() {
      finalized = true;
      stream.end();
      await uploadDone;
      return storageKey;
    },
  };
}
