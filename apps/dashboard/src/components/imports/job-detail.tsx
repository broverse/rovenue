import { Spinner } from "@heroui/react";
import { validateMapping } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Card, CardHeader } from "../../ui/card";
import { Chip } from "../../ui/chip";
import {
  useCancelImportJob,
  useCommitImportJob,
  useImportJob,
  useResumeImportJob,
  useStartDryRun,
} from "../../lib/hooks/useImports";
import {
  IMPORT_CANCELLABLE_STATUSES,
  IMPORT_JOB_KIND_DESCRIPTIONS,
  IMPORT_JOB_KIND_LABELS,
  IMPORT_MAPPING_EDITABLE_STATUSES,
  IMPORT_STATUS_LABELS,
} from "./constants";
import { MappingEditor } from "./mapping-editor";
import { DryRunSummary } from "./dry-run-summary";
import { JobStatusBanner } from "./status-banner";
import { ReportDownloadLink } from "./report-download-link";

// =============================================================
// Job detail — orchestrates upload → mapping → dry run → commit →
// progress → report for ONE job (Task 11)
// =============================================================
//
// Which pieces render is a pure function of `job.status`:
//   PENDING_MAPPING / FAILED / CANCELLED  → mapping editor + "start dry
//                                            run" (mapping is editable
//                                            and nothing is running)
//   DRY_RUN_RUNNING                       → status banner only (polling)
//   DRY_RUN_COMPLETE                      → mapping editor (still
//                                            editable) + dry-run summary
//                                            + "commit"
//   RUNNING / VERIFYING                   → status banner only (polling)
//   VERIFICATION_INCOMPLETE               → status banner (resume) +
//                                            summary (scope-labelled)
//   COMPLETED                             → status banner + summary +
//                                            report link
// The report link (`ReportDownloadLink`) renders independently of all
// of this — it only cares whether the job DTO says a report exists.

const STATUSES_WITH_SUMMARY = new Set([
  "DRY_RUN_COMPLETE",
  "VERIFICATION_INCOMPLETE",
  "VERIFYING",
  "COMPLETED",
  "RUNNING",
]);

export function ImportJobDetail({
  projectId,
  jobId,
}: {
  projectId: string;
  jobId: string;
}) {
  const { data, isLoading, error } = useImportJob(projectId, jobId);
  const startDryRun = useStartDryRun(projectId, jobId);
  const commit = useCommitImportJob(projectId, jobId);
  const resume = useResumeImportJob(projectId, jobId);
  const cancel = useCancelImportJob(projectId, jobId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-6 text-[13px] text-rv-mute-500">
        <Spinner size="sm" /> Loading…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div role="alert" className="rounded-md border border-rv-danger/30 bg-rv-danger/5 px-3 py-4 text-[13px] text-rv-danger">
        Couldn't load this import job.
      </div>
    );
  }

  const { job } = data;
  const mappingEditable = IMPORT_MAPPING_EDITABLE_STATUSES.has(job.status);
  // `job.kind` is not optional here: `validateMapping`'s default is
  // "HISTORY", so calling it without the kind demands `store` and
  // `purchaseDate` of a three-column token file and leaves this button
  // permanently disabled on every enrichment job — with no message
  // saying why, because the mapping editor's own error would be about
  // fields the file cannot have.
  const canStartDryRun = mappingEditable && validateMapping(job.mapping, job.kind).ok;
  const kindDescription = IMPORT_JOB_KIND_DESCRIPTIONS[job.kind];
  const canCommit = job.status === "DRY_RUN_COMPLETE";
  const canCancel = IMPORT_CANCELLABLE_STATUSES.has(job.status);

  return (
    <div
      className="space-y-4"
      data-testid="import-job-detail"
      data-job-status={job.status}
      data-job-kind={job.kind}
    >
      <Card padded>
        <CardHeader
          title={job.sourceLabel}
          subtitle={job.fileName}
          right={
            <div className="flex items-center gap-2">
              <Chip tone="default" data-testid="import-job-kind">
                {IMPORT_JOB_KIND_LABELS[job.kind]}
              </Chip>
              <Chip tone="default">{IMPORT_STATUS_LABELS[job.status]}</Chip>
              {canCancel && (
                <Button
                  variant="flat"
                  size="sm"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  Cancel
                </Button>
              )}
            </div>
          }
        />
        {kindDescription && (
          <p
            role="note"
            data-testid="import-job-kind-description"
            className="mt-3 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[12.5px] text-rv-mute-700"
          >
            {kindDescription}
          </p>
        )}
      </Card>

      <JobStatusBanner job={job} onResume={() => resume.mutate()} resuming={resume.isPending} />

      {mappingEditable && (
        <div>
          <MappingEditor projectId={projectId} job={job} />
          <Button
            variant="solid-primary"
            size="sm"
            className="mt-3"
            disabled={!canStartDryRun || startDryRun.isPending}
            onClick={() => startDryRun.mutate()}
          >
            Start dry run
          </Button>
        </div>
      )}

      {STATUSES_WITH_SUMMARY.has(job.status) && <DryRunSummary job={job} />}

      {canCommit && (
        <Button
          variant="solid-primary"
          size="sm"
          disabled={commit.isPending}
          onClick={() => commit.mutate()}
        >
          Commit import
        </Button>
      )}

      <ReportDownloadLink projectId={projectId} job={job} />
    </div>
  );
}
