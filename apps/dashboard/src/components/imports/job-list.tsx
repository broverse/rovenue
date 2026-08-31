import { Spinner } from "@heroui/react";
import { Chip } from "../../ui/chip";
import { cn } from "../../lib/cn";
import { useImportJobs } from "../../lib/hooks/useImports";
import { IMPORT_STATUS_LABELS } from "./constants";

interface ImportJobListProps {
  projectId: string;
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}

export function ImportJobList({ projectId, selectedJobId, onSelect }: ImportJobListProps) {
  const { data, isLoading } = useImportJobs(projectId);
  const jobs = data?.jobs ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-rv-mute-500">
        <Spinner size="sm" /> Loading…
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <p className="px-3 py-4 text-[13px] text-rv-mute-500" data-testid="import-job-list-empty">
        No imports yet.
      </p>
    );
  }

  return (
    <ul data-testid="import-job-list" className="divide-y divide-rv-divider">
      {jobs.map((job) => (
        <li key={job.id}>
          <button
            type="button"
            onClick={() => onSelect(job.id)}
            aria-current={job.id === selectedJobId}
            className={cn(
              "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13px] transition hover:bg-rv-c2",
              job.id === selectedJobId && "bg-rv-c2",
            )}
          >
            <span className="truncate">{job.sourceLabel}</span>
            <Chip tone="default">{IMPORT_STATUS_LABELS[job.status]}</Chip>
          </button>
        </li>
      ))}
    </ul>
  );
}
