import type { ImportJobStatus, ImportOutcome } from "../../lib/hooks/useImports";

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
 * Final-fix-wave FIX 9: this used to tell the operator to "request the
 * supplemental Google purchase-token file... and run a second import" —
 * that second import cannot succeed today (the token file's 3 columns can
 * never satisfy the mapper's required `store`/`purchaseDate` fields, and
 * no code path joins it to an existing purchase by user id regardless;
 * see the migrating-from-revenuecat guide and ROADMAP §11 for the
 * follow-up). The count itself stays — it is accurate and valuable — but
 * the recommended action is now one that actually works today.
 */
export function androidNoTokenWarning(count: number): string {
  const rows = count === 1 ? "subscription" : "subscriptions";
  return (
    `${count.toLocaleString()} Android ${rows} will import as history only — full ` +
    `purchase/revenue history, no live entitlement grant. Cut that user's app over to ` +
    `the Rovenue SDK and their next restorePurchases() call (or a live renewal) will ` +
    `re-verify against Play and grant access from then on.`
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
