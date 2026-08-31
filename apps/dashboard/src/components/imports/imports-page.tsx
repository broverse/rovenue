import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { Card, CardHeader } from "../../ui/card";
import { ImportJobList } from "./job-list";
import { ImportUploadForm } from "./upload-form";
import { ImportJobDetail } from "./job-detail";

/**
 * Top-level composition: a recent-jobs list the operator can pick from,
 * a new-import upload form, and the detail view for whichever job is
 * currently selected. `selectedJobId === null` means "show the upload
 * form" — selecting an existing job, or a fresh upload completing, both
 * just set this to a job id.
 */
export function ImportsPage({ projectId }: { projectId: string }) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <Card padded={false}>
        <CardHeader
          title="Recent imports"
          right={
            <Button
              variant="light"
              size="icon"
              aria-label="Start a new import"
              onClick={() => setSelectedJobId(null)}
            >
              <Plus size={14} />
            </Button>
          }
        />
        <ImportJobList
          projectId={projectId}
          selectedJobId={selectedJobId}
          onSelect={setSelectedJobId}
        />
      </Card>

      <div>
        {selectedJobId ? (
          <ImportJobDetail projectId={projectId} jobId={selectedJobId} />
        ) : (
          <ImportUploadForm projectId={projectId} onUploaded={(job) => setSelectedJobId(job.id)} />
        )}
      </div>
    </div>
  );
}
