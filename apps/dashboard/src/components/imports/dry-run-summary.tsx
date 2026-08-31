import { Chip } from "../../ui/chip";
import type { ImportJob } from "../../lib/hooks/useImports";
import {
  IMPORT_ANDROID_NO_TOKEN_OUTCOME,
  IMPORT_OUTCOME_LABELS,
  IMPORT_OUTCOME_ORDER,
  IMPORT_VERIFICATION_SCOPE_NOTE,
  androidNoTokenWarning,
} from "./constants";

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
  const scopeNote = job.verificationCountersScope
    ? IMPORT_VERIFICATION_SCOPE_NOTE[job.verificationCountersScope]
    : null;

  if (buckets.length === 0) {
    return (
      <p className="text-[13px] text-rv-mute-500" data-testid="import-summary-empty">
        No rows scanned yet.
      </p>
    );
  }

  return (
    <div data-testid="import-dry-run-summary">
      {scopeNote && (
        <p
          role="note"
          data-testid="import-verification-scope-note"
          className="mb-3 rounded-md border border-rv-warning/30 bg-rv-warning/5 px-3 py-2 text-[12.5px] text-rv-warning"
        >
          {scopeNote}
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
    </div>
  );
}
