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
import type { ImportJobKind } from "@rovenue/shared";
import * as importStore from "../../lib/import-store";

// =============================================================
// Outcome buckets — closed lists, one per job kind
// =============================================================
//
// Every row a job processes lands in EXACTLY ONE bucket of ITS OWN
// kind's list. See plan.ts's `classifyRow` (HISTORY) and enrich.ts's
// module comment (GOOGLE_TOKEN_ENRICHMENT) for the precedence a row is
// checked in when it would otherwise fit more than one bucket —
// documented there, not here, because the precedence is a classification
// decision, not part of the bucket list's own contract.
//
// These lists are what `import_jobs.counters` is keyed by, so a bucket
// missing from the list for a job's kind is a bucket that is SILENTLY
// UNCOUNTED — the run reports it in the NDJSON report and then loses the
// total. That is why `OUTCOMES_BY_KIND` below is a total `Record` over
// `ImportJobKind`: adding a kind without declaring its buckets is a
// compile error, mirroring @rovenue/shared's `REQUIRED_FIELDS_BY_KIND`.

/** HISTORY jobs: the eight buckets plan.ts/write.ts classify into. */
export const HISTORY_OUTCOMES = [
  "willCreate",
  "willUpdate",
  "skippedSandbox",
  "unresolvedProduct",
  "anchorless",
  "androidNoToken",
  "invalidRow",
  "duplicateInFile",
] as const;

export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];

/**
 * GOOGLE_TOKEN_ENRICHMENT jobs: the buckets `resolveEnrichmentTarget`
 * (enrich.ts) resolves a (subscriber, product) pair into, plus
 * `invalidRow` for a source row `normalizeEnrichmentRow` rejected before
 * it could ever reach a pair.
 *
 * DECLARED HERE, not in enrich.ts, and re-exported from there — the one
 * declaration this list is allowed to have. enrich.ts imports plan.ts
 * (for `resolveProduct`) and plan.ts imports THIS module, so a
 * report.ts -> enrich.ts import would close a cycle whose top-level
 * `const` initialisation order is entered differently depending on which
 * module a caller reaches first; a test that imports enrich.ts directly
 * would evaluate `IMPORT_OUTCOMES` below while `ENRICHMENT_OUTCOMES` was
 * still in its temporal dead zone. Keeping the declaration on the leaf
 * side of that edge is what makes "exactly one list" safe to state.
 *
 * `invalidRow` is deliberately shared with `HISTORY_OUTCOMES` rather
 * than given an enrichment-specific name: it means the same thing to an
 * operator in both flows, and `IMPORT_OUTCOMES` below de-duplicates it.
 */
export const ENRICHMENT_OUTCOMES = [
  "enriched",
  "alreadyEnriched",
  "noMatch",
  "ambiguousMatch",
  "ungroupedChains",
  "conflictingToken",
  "invalidRow",
] as const;

export type EnrichmentOutcome = (typeof ENRICHMENT_OUTCOMES)[number];

/** Any bucket any kind of import job can report. */
export type ImportOutcome = HistoryOutcome | EnrichmentOutcome;

const HISTORY_OUTCOME_SET: ReadonlySet<string> = new Set(HISTORY_OUTCOMES);

/**
 * Every distinct bucket, across every kind, de-duplicated
 * (`invalidRow` belongs to both lists) — the vocabulary a kind-agnostic
 * reader (a report parser, a counter-key sanity check) validates
 * against. A job's OWN counters are keyed by `OUTCOMES_BY_KIND[kind]`,
 * never by this union: a HISTORY job must not persist six zeroed
 * enrichment keys, and vice versa.
 */
export const IMPORT_OUTCOMES: readonly ImportOutcome[] = [
  ...HISTORY_OUTCOMES,
  ...ENRICHMENT_OUTCOMES.filter((outcome) => !HISTORY_OUTCOME_SET.has(outcome)),
];

/** The closed bucket list for one job kind. Total over `ImportJobKind`
 *  on purpose — see the section comment above. */
export const OUTCOMES_BY_KIND: Record<ImportJobKind, readonly ImportOutcome[]> = {
  HISTORY: HISTORY_OUTCOMES,
  GOOGLE_TOKEN_ENRICHMENT: ENRICHMENT_OUTCOMES,
};

// =============================================================
// Auxiliary counters — same jsonb column, not a bucket
// =============================================================
//
// A pass sometimes needs to persist a number that is NOT a row bucket:
// something counted in a different unit, that no bucket can express and
// that cannot be derived from the buckets. These keys live in the same
// `import_jobs.counters` object, deliberately outside the bucket
// vocabulary (the same separation verify.ts's `verifyAnchor*` keys use).
//
// They are declared HERE, beside the buckets, and not in the pass that
// writes them, for one concrete reason: the dry-run namespace
// (`dryRun_`-prefixed) is applied and reversed by this module, and a key
// this module does not know about is silently DROPPED when a pre-commit
// job's counters are reconstructed for the API. That is not a
// hypothetical — it is exactly what happened to both keys below on their
// first outing, in the one phase they exist for.

/** GOOGLE_TOKEN_ENRICHMENT. The outcome buckets count SOURCE ROWS (that
 *  is what a job's counters have always described, and what a report
 *  line corresponds to). These count PURCHASE ROWS: one enrichment row
 *  can patch a whole renewal chain, so "4 rows" and "11 subscriptions"
 *  are different numbers and neither is derivable from the other. */
export const ENRICHMENT_COUNTER_KEYS = {
  /** Purchase rows the run wrote, or on a dry run would write. */
  ENRICHED_PURCHASE_ROWS: "enrichedPurchaseRows",
  /** Purchase rows `enrichUngroupedChains` would ADDITIONALLY reach if
   *  the operator turned it on. This is the number the dry-run summary's
   *  opt-in callout quotes, so it has to survive the pre-commit
   *  reconstruction below or the callout offers to enrich zero rows. */
  UNGROUPED_PURCHASE_ROWS: "ungroupedChainsPurchaseRows",
} as const;

/** Auxiliary keys each kind's passes persist alongside their buckets.
 *  Total over `ImportJobKind`, same reason as `OUTCOMES_BY_KIND`. */
export const AUXILIARY_COUNTER_KEYS_BY_KIND: Record<ImportJobKind, readonly string[]> = {
  HISTORY: [],
  GOOGLE_TOKEN_ENRICHMENT: Object.values(ENRICHMENT_COUNTER_KEYS),
};

/**
 * A complete, all-zero counter record over one kind's bucket list.
 *
 * Takes the LIST rather than the kind so the returned record is typed to
 * exactly those buckets (`Record<HistoryOutcome, number>` for
 * `HISTORY_OUTCOMES`), which is what lets `buildDryRunCounters` below
 * require a complete record instead of defaulting absent keys to zero —
 * a default is how a bucket that stopped being counted goes unnoticed.
 */
export function emptyOutcomeCounters<K extends ImportOutcome>(
  outcomes: readonly K[],
): Record<K, number> {
  return Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<K, number>;
}

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

export function dryRunCounterKey(key: string): string {
  return `${DRY_RUN_COUNTER_PREFIX}${key}`;
}

/** Every counter key a job of this kind persists — buckets first, then
 *  auxiliaries. The single list both halves of the dry-run namespace are
 *  driven by, so a key can never be written under the prefix and then
 *  not read back out of it. */
export function counterKeysForKind(kind: ImportJobKind): readonly string[] {
  return [...OUTCOMES_BY_KIND[kind], ...AUXILIARY_COUNTER_KEYS_BY_KIND[kind]];
}

/**
 * Builds the full prefixed-key object `setImportJobCounters` persists for
 * one dry-run attempt — always the complete, from-scratch count for every
 * key of THAT JOB'S KIND, never a delta and never another kind's keys.
 *
 * `outcomes` is the bucket list the counts were accumulated over
 * (`HISTORY_OUTCOMES` / `ENRICHMENT_OUTCOMES`), typed so a missing bucket
 * is a compile error rather than a defaulted zero. `auxiliary` carries
 * that kind's non-bucket keys; they are prefixed too, because a dry run
 * writing them PLAIN would leave them indistinguishable from a commit
 * run's — and `readDryRunCounters` below, which rebuilds the object from
 * the key list alone, would drop them.
 */
export function buildDryRunCounters<K extends ImportOutcome>(
  outcomes: readonly K[],
  counts: Record<K, number>,
  auxiliary: Record<string, number> = {},
): Record<string, number> {
  return Object.fromEntries([
    ...outcomes.map((outcome) => [dryRunCounterKey(outcome), counts[outcome]]),
    ...Object.entries(auxiliary).map(([key, value]) => [dryRunCounterKey(key), value]),
  ]);
}

/**
 * Reverses `buildDryRunCounters` — reads the dry-run pass's own counts
 * back out of a job's persisted `counters` object, defaulting an absent
 * key to 0 (a job that has never had a dry run yet).
 *
 * Takes the KIND rather than a key list because its caller (the route's
 * `toDto`) has only a job row, and because driving both directions from
 * `counterKeysForKind` is what stops the two halves from disagreeing
 * about which keys exist.
 */
export function readDryRunCounters(
  kind: ImportJobKind,
  counters: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    counterKeysForKind(kind).map((key) => [key, counters[dryRunCounterKey(key)] ?? 0]),
  );
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
