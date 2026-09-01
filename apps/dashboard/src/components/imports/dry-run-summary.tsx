import { Chip } from "../../ui/chip";
import type { ImportJob } from "../../lib/hooks/useImports";
import {
  IMPORT_ANDROID_NO_TOKEN_OUTCOME,
  IMPORT_OUTCOME_LABELS,
  IMPORT_OUTCOME_ORDER,
  IMPORT_VERIFICATION_SCOPE_NOTE,
  IMPORT_VERIFY_COUNTER_LABELS,
  IMPORT_VERIFY_COUNTER_ORDER,
  androidNoTokenWarning,
  duplicateTrackingDisclosure,
} from "./constants";

/**
 * Final-fix-wave FIX 7: `job.dryRunSummary` was computed by `planImport`
 * on every dry run but never persisted anywhere a client could read it
 * — including the observed event-date range, whose own doc comment
 * (services/import/plan.ts) says the operator must see it BEFORE
 * committing (`revenue_events` has no default partition; a date outside
 * every provisioned month fails the write outright). Rendered ABOVE the
 * outcome buckets for exactly that reason — it belongs to the decision
 * "is it safe to commit this file", not to the row-level breakdown.
 */
function DryRunDisclosures({ summary }: { summary: NonNullable<ImportJob["dryRunSummary"]> }) {
  const { observedEventDateRange, requiredPartitionSpan, entitlementShapeCounts } = summary;
  const entitlementShapes = Object.entries(entitlementShapeCounts).filter(
    ([, count]) => count > 0,
  );

  if (!observedEventDateRange && !requiredPartitionSpan && entitlementShapes.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="import-dry-run-disclosures"
      className="mb-3 rounded-lg border border-rv-divider bg-rv-c2 px-3 py-2 text-[12.5px] text-rv-mute-700"
    >
      {observedEventDateRange && (
        <p data-testid="import-observed-event-date-range">
          <span className="font-medium">Observed purchase dates: </span>
          {new Date(observedEventDateRange.min).toLocaleDateString()} –{" "}
          {new Date(observedEventDateRange.max).toLocaleDateString()}
        </p>
      )}
      {requiredPartitionSpan && (
        <p data-testid="import-required-partition-span" className="mt-1">
          <span className="font-medium">Revenue history spans: </span>
          {requiredPartitionSpan.fromMonth} to {requiredPartitionSpan.toMonth} (
          {requiredPartitionSpan.monthCount.toLocaleString()} month
          {requiredPartitionSpan.monthCount === 1 ? "" : "s"})
        </p>
      )}
      {entitlementShapes.length > 0 && (
        <p data-testid="import-entitlement-shape-counts" className="mt-1">
          <span className="font-medium">Entitlement identifier formats seen: </span>
          {entitlementShapes
            .map(([shape, count]) => `${shape} (${count.toLocaleString()})`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

/**
 * Final-fix-wave minor fix: Phase B's own verification counters had no
 * UI representation at all — `verificationCountersScope`'s scope note
 * used to render directly above the Phase-A row buckets it does not
 * describe, with nothing underneath actually showing the numbers the
 * note was talking about. This section IS that: it renders ONLY once
 * Phase B has touched this job (`scope` non-null), with the scope note
 * directly above it, describing the counters immediately below rather
 * than an unrelated list.
 */
function VerificationCounters({
  job,
  scope,
}: {
  job: ImportJob;
  scope: NonNullable<ImportJob["verificationCountersScope"]>;
}) {
  const verifyBuckets = IMPORT_VERIFY_COUNTER_ORDER.map((key) => ({
    key,
    count: job.counters[key] ?? 0,
  })).filter((bucket) => bucket.count > 0);

  return (
    <div className="mt-4" data-testid="import-verification-counters">
      <p
        role="note"
        data-testid="import-verification-scope-note"
        className="mb-3 rounded-md border border-rv-warning/30 bg-rv-warning/5 px-3 py-2 text-[12.5px] text-rv-warning"
      >
        {IMPORT_VERIFICATION_SCOPE_NOTE[scope]}
      </p>
      {/* All-zero is a real, if unusual, state (e.g. the anchor cap was
          hit before this call resolved anything) — the scope note above
          still needs to render; there just isn't a non-zero bucket to
          list underneath it. */}
      {verifyBuckets.length > 0 && (
        <ul className="divide-y divide-rv-divider rounded-lg border border-rv-divider">
          {verifyBuckets.map(({ key, count }) => (
            <li
              key={key}
              data-testid={`import-verify-counter-${key}`}
              className="flex items-center justify-between px-3 py-2 text-[13px]"
            >
              <span>{IMPORT_VERIFY_COUNTER_LABELS[key]}</span>
              <Chip tone="default">{count.toLocaleString()}</Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =============================================================
// Dry-run / verification outcome summary
// =============================================================
//
// Renders `job.counters` — the SAME aggregate object the dry-run planner
// and Phase-B verifier increment server-side
// (packages/db/src/drizzle/repositories/import-jobs.ts's
// `incrementImportJobCounters`) — as one row per NON-ZERO outcome
// bucket. A bucket at zero is omitted rather than shown as "0": an empty
// file-wide category is not something the operator needs to read past.

export function DryRunSummary({ job }: { job: ImportJob }) {
  const buckets = IMPORT_OUTCOME_ORDER.map((outcome) => ({
    outcome,
    count: job.counters[outcome] ?? 0,
  })).filter((bucket) => bucket.count > 0);

  const androidCount = job.counters[IMPORT_ANDROID_NO_TOKEN_OUTCOME] ?? 0;
  const duplicateTrackingDisabledAfterKeys =
    job.dryRunSummary?.duplicateTrackingDisabledAfterKeys ?? null;

  if (buckets.length === 0) {
    return (
      <p className="text-[13px] text-rv-mute-500" data-testid="import-summary-empty">
        No rows scanned yet.
      </p>
    );
  }

  return (
    <div data-testid="import-dry-run-summary">
      {job.dryRunSummary && <DryRunDisclosures summary={job.dryRunSummary} />}

      {duplicateTrackingDisabledAfterKeys !== null && (
        <p
          role="alert"
          data-testid="import-duplicate-tracking-disclosure"
          className="mb-3 rounded-md border border-rv-warning/30 bg-rv-warning/5 px-3 py-2 text-[12.5px] text-rv-warning"
        >
          {duplicateTrackingDisclosure(duplicateTrackingDisabledAfterKeys)}
        </p>
      )}

      <ul className="divide-y divide-rv-divider rounded-lg border border-rv-divider">
        {buckets.map(({ outcome, count }) => (
          <li
            key={outcome}
            data-testid={`import-outcome-${outcome}`}
            className="flex items-center justify-between px-3 py-2 text-[13px]"
          >
            <span>{IMPORT_OUTCOME_LABELS[outcome]}</span>
            <Chip tone="default">{count.toLocaleString()}</Chip>
          </li>
        ))}
      </ul>

      {androidCount > 0 && (
        <p
          role="alert"
          data-testid="import-android-no-token-warning"
          className="mt-3 rounded-md border border-rv-warning/30 bg-rv-warning/5 px-3 py-2 text-[12.5px] text-rv-warning"
        >
          {androidNoTokenWarning(androidCount)}
        </p>
      )}

      {job.verificationCountersScope && (
        <VerificationCounters job={job} scope={job.verificationCountersScope} />
      )}
    </div>
  );
}
