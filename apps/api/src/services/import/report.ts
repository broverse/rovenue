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
 */
export function createReportWriter(projectId: string, jobId: string): ReportWriter {
  const storageKey = importStore.buildReportStorageKey(projectId, jobId);
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
