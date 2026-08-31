import { Spinner } from "@heroui/react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import type { ImportJob, ImportJobStatus } from "../../lib/hooks/useImports";
import { IMPORT_ERROR_STATUSES, IMPORT_RESUMABLE_STATUSES, IMPORT_STATUS_LABELS } from "./constants";

// =============================================================
// Job status banner
// =============================================================
//
// Task-11 controller context, honesty item 1: VERIFICATION_INCOMPLETE
// (store quota ran out mid-verification, resumable) and VERIFYING
// (verification in progress right now — OR a crashed worker left the
// row there, indistinguishable from here) are both normal resting
// states, never failures. `role` and tone are driven by
// `IMPORT_ERROR_STATUSES` — currently just `FAILED` — so those two
// statuses get the SAME neutral/informational treatment as
// RUNNING/DRY_RUN_RUNNING, never the danger styling FAILED gets, and
// both expose the resume action (`IMPORT_RESUMABLE_STATUSES`).

const ACTIVE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "DRY_RUN_RUNNING",
  "RUNNING",
  "VERIFYING",
]);

const STATUS_COPY: Partial<Record<ImportJobStatus, string>> = {
  DRY_RUN_RUNNING: "Scanning the file for a dry-run preview…",
  RUNNING: "Importing subscriber history…",
  VERIFYING: "Verifying store receipts for imported rows…",
  VERIFICATION_INCOMPLETE:
    "Verification paused: the store-verification quota ran out partway through. Resume to continue from where it left off.",
  COMPLETED: "Import complete.",
  FAILED: "Import failed.",
  CANCELLED: "Import was cancelled.",
};

interface JobStatusBannerProps {
  job: ImportJob;
  onResume: () => void;
  resuming: boolean;
}

export function JobStatusBanner({ job, onResume, resuming }: JobStatusBannerProps) {
  const copy = STATUS_COPY[job.status];
  // PENDING_MAPPING and DRY_RUN_COMPLETE have no banner of their own —
  // the mapping editor / dry-run summary + commit action ARE the UI for
  // those two statuses.
  if (!copy) return null;

  const isError = IMPORT_ERROR_STATUSES.has(job.status);
  const isResumable = IMPORT_RESUMABLE_STATUSES.has(job.status);
  const isActive = ACTIVE_STATUSES.has(job.status);
  const isWarning = job.status === "VERIFICATION_INCOMPLETE";
  const isSuccess = job.status === "COMPLETED";

  return (
    <div
      role={isError ? "alert" : "status"}
      data-testid="import-status-banner"
      data-status={job.status}
      className={cn(
        "rounded-md border px-3 py-2 text-[13px]",
        isError && "border-rv-danger/30 bg-rv-danger/5 text-rv-danger",
        isWarning && "border-rv-warning/30 bg-rv-warning/5 text-rv-warning",
        isSuccess && "border-rv-success/30 bg-rv-success/5 text-rv-success",
        !isError && !isWarning && !isSuccess && "border-rv-divider bg-rv-c2 text-rv-mute-700",
      )}
    >
      <div className="flex items-center gap-2">
        {isActive && <Spinner size="sm" />}
        <span>{IMPORT_STATUS_LABELS[job.status]}: </span>
        <span>{copy}</span>
      </div>
      {job.status === "FAILED" && job.errorMessage && (
        <p className="mt-1 text-[12.5px] text-rv-danger/80">{job.errorMessage}</p>
      )}
      {isResumable && (
        <Button
          variant="flat"
          size="sm"
          className="mt-2"
          disabled={resuming}
          onClick={onResume}
        >
          Resume import
        </Button>
      )}
    </div>
  );
}
