import { useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { useUploadImportJob, type ImportJob } from "../../lib/hooks/useImports";

interface ImportUploadFormProps {
  projectId: string;
  onUploaded: (job: ImportJob) => void;
}

export function ImportUploadForm({ projectId, onUploaded }: ImportUploadFormProps) {
  const upload = useUploadImportJob(projectId);
  const [file, setFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [progress, setProgress] = useState(0);

  const handleSubmit = () => {
    if (!file) return;
    upload.mutate(
      { file, sourceLabel: sourceLabel.trim() || undefined, onProgress: setProgress },
      { onSuccess: onUploaded },
    );
  };

  return (
    <div className="space-y-3 rounded-lg border border-rv-divider bg-rv-c1 p-4">
      <div>
        <label className="mb-1 block text-[12px] font-medium text-rv-mute-600">
          Export file (CSV)
        </label>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Import file"
          disabled={upload.isPending}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="block w-full text-[13px] text-rv-mute-700 file:mr-3 file:rounded-md file:border-0 file:bg-rv-c2 file:px-3 file:py-1.5 file:text-[13px]"
        />
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-medium text-rv-mute-600">
          Label (optional)
        </label>
        <Input
          value={sourceLabel}
          disabled={upload.isPending}
          placeholder={file?.name ?? "e.g. RevenueCat export — August"}
          onChange={(event) => setSourceLabel(event.target.value)}
        />
      </div>

      <Button
        variant="solid-primary"
        size="sm"
        disabled={!file || upload.isPending}
        onClick={handleSubmit}
      >
        <Upload size={13} />
        {upload.isPending ? `Uploading… ${progress}%` : "Upload"}
      </Button>

      {upload.isError && (
        <p role="alert" className="text-[13px] text-rv-danger">
          {upload.error instanceof Error ? upload.error.message : "Upload failed."}
        </p>
      )}
    </div>
  );
}
