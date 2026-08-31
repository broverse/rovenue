import { Download } from "lucide-react";
import { importReportUrl, type ImportJob } from "../../lib/hooks/useImports";

// =============================================================
// Report download link
// =============================================================
//
// `GET .../imports/:id/report` 404s until a report actually exists
// (apps/api/src/routes/dashboard/imports.ts) — either the dry-run
// planner's single `reportStorageKey`, or one-or-more commit-attempt
// parts (`reportPartCount > 0`). Both are plain fields on the job DTO,
// so availability is a pure read of the job the page already has — no
// speculative HEAD request, no link that 404s when clicked.

export function ReportDownloadLink({
  projectId,
  job,
}: {
  projectId: string;
  job: ImportJob;
}) {
  const available = job.reportPartCount > 0 || job.reportStorageKey !== null;
  if (!available) return null;

  return (
    <a
      href={importReportUrl(projectId, job.id)}
      target="_blank"
      rel="noreferrer"
      data-testid="import-report-download-link"
      className="inline-flex items-center gap-1.5 text-[13px] text-rv-accent-500 underline underline-offset-2"
    >
      <Download size={13} />
      Download report
    </a>
  );
}
