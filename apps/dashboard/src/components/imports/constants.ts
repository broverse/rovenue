import type {
  EnrichmentOutcome,
  ImportJobKind,
  ImportJobStatus,
  ImportOutcome,
} from "../../lib/hooks/useImports";

// =============================================================
// Data-import page — every interval, threshold and label in one place
// =============================================================
//
// Standing rule on this repo: no magic values. A reviewer checking this
// page should be able to see the whole "how often does it poll, what
// counts as done, what does each bucket mean" envelope right here,
// mirroring packages/shared/src/import/constants.ts's own "the numbers,
// in one place" convention on the backend side of this same feature.

/**
 * How often `useImportJob` polls `GET .../imports/:id` while a job is
 * actively running (`IMPORT_ACTIVE_POLL_STATUSES` below).
 *
 * Chosen against the shared, project-scoped budget the backend documents
 * on `IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE` (120 requests/minute,
 * shared across `GET /` and `GET /:id`, shared across every operator
 * watching the same project): one viewer polling every 5s spends 12 of
 * those 120 requests per minute. Polling only happens while the job is
 * in one of `IMPORT_ACTIVE_POLL_STATUSES` — not for the whole time the
 * page is open — so the worst case is bounded by how many viewers have
 * an ACTIVE job open on the same project at once. At 12 req/min/viewer,
 * ten simultaneous viewers (ten browser tabs, or several operators
 * watching the same migration) would exactly saturate the 120/min
 * budget; realistic usage (one or two people watching one run) uses a
 * small fraction of it, with headroom left for `GET /` list-view traffic
 * on top.
 */
export const IMPORT_POLL_INTERVAL_MS = 5_000;

/**
 * Statuses `useImportJob` polls for. Everything else is either not
 * running anything yet (`PENDING_MAPPING`, `DRY_RUN_COMPLETE`) or a
 * resting/terminal outcome (`COMPLETED`, `FAILED`, `CANCELLED`,
 * `VERIFICATION_INCOMPLETE`) that only changes again when the operator
 * takes an action (edit mapping, start dry run, commit, resume) — so
 * polling for those would burn the shared budget on a value that isn't
 * moving. `VERIFYING` IS included even though a crashed worker can leave
 * a row stuck there (task-11 controller context, honesty item 1) —
 * there is no way to tell "actively running" from "crashed" from the
 * dashboard, and continuing to poll is the only way to notice if/when it
 * resolves on its own; the resume affordance (`IMPORT_RESUMABLE_STATUSES`)
 * is the operator's recourse if it never does.
 */
export const IMPORT_ACTIVE_POLL_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "DRY_RUN_RUNNING",
  "RUNNING",
  "VERIFYING",
]);

/**
 * Statuses the mapping may be edited from, and a dry run may be started
 * from — mirrors the server's own `MAPPING_EDITABLE_STATUSES` /
 * `DRY_RUN_STARTABLE_STATUSES` (apps/api/src/routes/dashboard/imports.ts),
 * which are themselves the SAME set for the same reason: a dry run reads
 * the CURRENT mapping, so both actions are only safe from a status where
 * nothing else is using it right now.
 */
export const IMPORT_MAPPING_EDITABLE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "PENDING_MAPPING",
  "DRY_RUN_COMPLETE",
  "FAILED",
  "CANCELLED",
]);

/**
 * Final-fix-wave FIX 6: mirrors the server's
 * DEFAULT_SKIP_SANDBOX/DEFAULT_IMPORT_ANCHORLESS
 * (apps/api/src/services/import/write.ts) — the mapping editor's opt-in
 * controls start from the SAME defaults a job with no explicit
 * `options` yet actually runs under, so the checkboxes never show a
 * state the backend wouldn't otherwise be using.
 */
export const IMPORT_DEFAULT_SKIP_SANDBOX = true;
export const IMPORT_DEFAULT_IMPORT_ANCHORLESS = true;

/** Mirrors the server's `RESUMABLE_STATUSES` — see task-11 controller
 *  context honesty item 1: both are legitimate, non-error resting states
 *  that a resume can move forward, not failures. */
export const IMPORT_RESUMABLE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "VERIFICATION_INCOMPLETE",
  "VERIFYING",
]);

/** Mirrors the server's `CANCELLABLE_STATUSES`. */
export const IMPORT_CANCELLABLE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "PENDING_MAPPING",
  "DRY_RUN_RUNNING",
  "DRY_RUN_COMPLETE",
  "RUNNING",
  "VERIFICATION_INCOMPLETE",
  "VERIFYING",
]);

/** Statuses that read as an error/failure in the UI — everything else
 *  (including VERIFICATION_INCOMPLETE and VERIFYING) gets neutral or
 *  informational styling. Task-11 controller context honesty item 1 is
 *  explicit that VERIFICATION_INCOMPLETE and VERIFYING must NOT be
 *  presented as failures. */
export const IMPORT_ERROR_STATUSES: ReadonlySet<ImportJobStatus> = new Set(["FAILED"]);

/** Outcome buckets in report precedence order (mirrors
 *  apps/api/src/services/import/report.ts's `IMPORT_OUTCOMES`), each
 *  with the label the dry-run summary renders it under. */
export const IMPORT_OUTCOME_ORDER: readonly ImportOutcome[] = [
  "willCreate",
  "willUpdate",
  "skippedSandbox",
  "unresolvedProduct",
  "anchorless",
  "androidNoToken",
  "invalidRow",
  "duplicateInFile",
];

export const IMPORT_OUTCOME_LABELS: Record<ImportOutcome, string> = {
  willCreate: "Will create",
  willUpdate: "Will update",
  skippedSandbox: "Skipped (sandbox)",
  unresolvedProduct: "Unresolved product",
  anchorless: "Anchorless (promotional / manual grant)",
  androidNoToken: "Android — missing purchase token",
  invalidRow: "Invalid row",
  duplicateInFile: "Duplicate in file",
};

/** The one bucket that needs a louder, non-chip callout (task-11
 *  controller context honesty item 3): a boolean "some rows lack tokens"
 *  is not actionable, a count plus next step is. */
export const IMPORT_ANDROID_NO_TOKEN_OUTCOME: ImportOutcome = "androidNoToken";

// =============================================================
// GOOGLE_TOKEN_ENRICHMENT buckets
// =============================================================
//
// A separate order + label pair, not extra entries on the history lists
// above, because a job reports the buckets of its OWN kind and no
// others: the server keys `import_jobs.counters` by
// `OUTCOMES_BY_KIND[kind]`. Rendering the union would show every one of
// the other kind's buckets as absent — indistinguishable, in this UI,
// from a real zero.

export const IMPORT_ENRICHMENT_OUTCOME_ORDER: readonly EnrichmentOutcome[] = [
  "enriched",
  "alreadyEnriched",
  "ungroupedChains",
  "ambiguousMatch",
  "conflictingToken",
  "noMatch",
  "invalidRow",
];

export const IMPORT_ENRICHMENT_OUTCOME_LABELS: Record<EnrichmentOutcome, string> = {
  enriched: "Token applied",
  alreadyEnriched: "Already had this token",
  ungroupedChains: "Renewals not linked — needs an opt-in",
  ambiguousMatch: "Ambiguous — skipped",
  conflictingToken: "Conflicting token already stored — skipped",
  noMatch: "No matching Play purchase",
  invalidRow: "Invalid row",
};

/** Purchase-row counters the enrichment pass persists ALONGSIDE its
 *  outcome buckets (apps/api's `ENRICHMENT_COUNTER_KEYS`). The buckets
 *  count source rows; these count purchase rows, and one enrichment row
 *  can cover a whole renewal chain — "3 rows" and "3 subscriptions" are
 *  different numbers and neither is derivable from the other. */
export const IMPORT_ENRICHED_PURCHASE_ROWS_KEY = "enrichedPurchaseRows";
export const IMPORT_UNGROUPED_PURCHASE_ROWS_KEY = "ungroupedChainsPurchaseRows";

/**
 * The `ungroupedChains` bucket's callout — the ONLY place
 * `enrichUngroupedChains` is discoverable from a dry run.
 *
 * The option is settable through `PATCH .../mapping` and read by the
 * resolver, but nothing else surfaces it. An operator whose whole file
 * lands in this bucket (the common case for a RevenueCat Transactions
 * export, which has no original-transaction column — so write.ts's NOT
 * NULL fallback made every renewal its own one-row chain) would
 * otherwise see a file-wide refusal with no stated way forward and
 * conclude the enrichment simply does not work.
 */
export function ungroupedChainsWarning(rows: number, purchaseRows: number): string {
  const subject = rows === 1 ? "subscriber" : "subscribers";
  return (
    `${rows.toLocaleString()} ${subject} could not be enriched because their imported renewals ` +
    `are not linked to each other — the history export carried no original-transaction column, ` +
    `so each renewal became its own one-row chain. Turn on "Link unlinked renewals" below and ` +
    `re-run the dry run to enrich ${purchaseRows.toLocaleString()} more purchase row(s). It ` +
    `never applies where the export DID express chains, and never overwrites a stored token.`
  );
}

/** Label + explanation for the `enrichUngroupedChains` checkbox, kept
 *  next to the warning above so the two always describe the same thing. */
export const IMPORT_ENRICH_UNGROUPED_CHAINS_LABEL = "Link unlinked renewals";
export const IMPORT_ENRICH_UNGROUPED_CHAINS_HINT =
  "Treat a subscriber's unlinked Android renewals for one product as a single subscription. " +
  "Only applies when the history export expressed no subscription chains at all, and never when " +
  "the file supplies two different tokens for the same subscriber and product. Off by default.";

/** Mirrors the server's `DEFAULT_ENRICH_UNGROUPED_CHAINS`
 *  (apps/api/src/services/import/enrich.ts) — the checkbox must start
 *  from the state a job with no explicit `options` actually runs under. */
export const IMPORT_DEFAULT_ENRICH_UNGROUPED_CHAINS = false;

/**
 * Final-fix-wave minor fix: Phase B's own verification counters
 * (verify.ts's `VERIFY_COUNTER_KEYS`, a SEPARATE namespace from the
 * Phase-A outcome buckets above) had NO UI representation at all —
 * `verificationCountersScope`'s "inspected subset, not the whole file"
 * note rendered directly above the Phase-A row buckets it doesn't
 * describe, with nothing underneath it actually showing the numbers it
 * WAS talking about. This is that missing section.
 */
export type ImportVerifyCounterKey =
  | "verifyAnchorVerified"
  | "verifyAnchorNotFound"
  | "verifyAnchorPending"
  | "verifyAnchorUnverifiable";

export const IMPORT_VERIFY_COUNTER_ORDER: readonly ImportVerifyCounterKey[] = [
  "verifyAnchorVerified",
  "verifyAnchorNotFound",
  "verifyAnchorPending",
  "verifyAnchorUnverifiable",
];

export const IMPORT_VERIFY_COUNTER_LABELS: Record<ImportVerifyCounterKey, string> = {
  verifyAnchorVerified: "Verified live",
  verifyAnchorNotFound: "Store no longer recognises (kept as history)",
  verifyAnchorPending: "Pending (throttled — will retry on resume)",
  verifyAnchorUnverifiable: "Unverifiable (e.g. store not connected)",
};

/**
 * Final-fix-wave FIX 9 told the operator to cut their app over to the SDK
 * and wait for a `restorePurchases()` call, because the second import this
 * message ORIGINALLY recommended could not succeed: the token file's three
 * columns could never satisfy the then-global required `store`/
 * `purchaseDate` fields, and nothing joined a token to an existing
 * purchase.
 *
 * Both halves of that now exist (`import_jobs.kind` gates the required
 * fields; `runEnrichmentJob` does the join), so the second pass is named
 * FIRST — it is the action that recovers these subscriptions without
 * waiting on the user's device — with the SDK cut-over kept as what covers
 * anyone the token file misses.
 */
export function androidNoTokenWarning(count: number): string {
  const rows = count === 1 ? "subscription" : "subscriptions";
  return (
    `${count.toLocaleString()} Android ${rows} will import as history only — full ` +
    `purchase/revenue history, no live entitlement grant. Recover them by uploading ` +
    `RevenueCat's supplemental purchase-token file as a second import once this one has ` +
    `completed. Failing that, cutting the user's app over to the Rovenue SDK re-verifies ` +
    `against Play on their next restorePurchases() call or renewal.`
  );
}

/**
 * Final-fix-wave FIX 7: `job.dryRunSummary.duplicateTrackingDisabledAfterKeys`
 * — disclosed, not silent (spec ruling: duplicate tracking is "bounded
 * with a disclosed cap"). Null means every distinct (store,
 * storeTransactionId) key in the file was tracked exactly; a number
 * means tracking stopped at that many keys and later in-file duplicates
 * past that point may have been missed (never falsely flagged).
 */
export function duplicateTrackingDisclosure(disabledAfterKeys: number): string {
  return (
    `Duplicate-in-file detection stopped after ${disabledAfterKeys.toLocaleString()} distinct ` +
    `transaction keys (a safety cap for very large files). Duplicates beyond that point may not ` +
    `have been flagged — they were never incorrectly flagged, only possibly missed.`
  );
}

/**
 * How each kind of import job describes itself, wherever a job's
 * identity has to be stated rather than assumed.
 *
 * The enrichment entry exists because the page's whole vocabulary —
 * "import", "will create", "commit" — is wrong for a pass that creates
 * nothing. An operator who is not told this job PATCHES existing
 * purchases will reasonably read a low `enriched` count as a failed
 * import and re-upload their history file.
 */
export const IMPORT_JOB_KIND_LABELS: Record<ImportJobKind, string> = {
  HISTORY: "History import",
  GOOGLE_TOKEN_ENRICHMENT: "Google purchase-token second pass",
};

export const IMPORT_JOB_KIND_DESCRIPTIONS: Record<ImportJobKind, string | null> = {
  HISTORY: null,
  GOOGLE_TOKEN_ENRICHMENT:
    "This pass creates nothing. It attaches Google Play purchase tokens to Android purchases a " +
    "previous history import already wrote, so those subscriptions can be verified against Play " +
    "and grant live access. Run it after the history import has completed.",
};

/** Human labels for the job-list rows and the header chip. */
export const IMPORT_STATUS_LABELS: Record<ImportJobStatus, string> = {
  PENDING_MAPPING: "Needs mapping",
  DRY_RUN_RUNNING: "Dry run running",
  DRY_RUN_COMPLETE: "Dry run complete",
  RUNNING: "Importing",
  VERIFYING: "Verifying",
  VERIFICATION_INCOMPLETE: "Verification incomplete",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const IMPORT_VERIFICATION_SCOPE_NOTE: Record<
  "inspectedSubset" | "wholeFile",
  string | null
> = {
  // Task-11 controller context honesty item 2: when the anchor cap was
  // hit mid-verification, these counters describe only the anchors that
  // were actually inspected, not the whole file — presenting them as a
  // total would be exactly the "quiet lie" this feature exists to avoid.
  inspectedSubset:
    "These counts cover only the anchors inspected before the verification limit was reached — not the whole file. Resume to continue verifying the rest.",
  wholeFile: null,
};
