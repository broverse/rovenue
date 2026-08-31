import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CanonicalField } from "@rovenue/shared";
import { API_BASE_URL, ApiError, api } from "../api";
import {
  IMPORT_ACTIVE_POLL_STATUSES,
  IMPORT_POLL_INTERVAL_MS,
} from "../../components/imports/constants";

// =============================================================
// Dashboard: data-import job hooks (Task 11)
// =============================================================
//
// Mirrors useAssets.ts's shape: a plain `api()` round-trip for every
// mutation except the one that genuinely needs upload progress, which
// bypasses `api()`/`fetch` for the same reason useAssets.ts's upload
// does — `XMLHttpRequest.upload.onprogress` is the only standard way to
// get real, determinate progress on the REQUEST body, and an import
// upload can be gigabytes (IMPORT_MAX_UPLOAD_BYTES).
//
// Job status TYPE is duplicated here from the server's own duplicated
// copy (apps/api/src/routes/dashboard/imports.ts re-derives it from the
// Drizzle enum rather than sharing a type across the fetch boundary) —
// same "redeclare the literal union at each boundary" pattern already
// used twice in this feature.

export type ImportJobStatus =
  | "PENDING_MAPPING"
  | "DRY_RUN_RUNNING"
  | "DRY_RUN_COMPLETE"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "VERIFICATION_INCOMPLETE"
  | "VERIFYING";

/** Closed outcome-bucket list — mirrors apps/api/src/services/import/report.ts's
 *  `IMPORT_OUTCOMES` (not shared across the fetch boundary; see the module
 *  comment above). */
export type ImportOutcome =
  | "willCreate"
  | "willUpdate"
  | "skippedSandbox"
  | "unresolvedProduct"
  | "anchorless"
  | "androidNoToken"
  | "invalidRow"
  | "duplicateInFile";

export type VerificationCountersScope = "wholeFile" | "inspectedSubset" | null;

export interface ImportJob {
  id: string;
  projectId: string;
  createdByUserId: string | null;
  sourceLabel: string;
  presetId: string | null;
  fileName: string;
  fileBytes: number;
  fileSha256: string;
  mapping: Record<string, CanonicalField>;
  options: { skipSandbox?: boolean; importAnchorless?: boolean };
  status: ImportJobStatus;
  checkpointLine: number;
  counters: Partial<Record<ImportOutcome, number>> & Record<string, number>;
  reportStorageKey: string | null;
  reportPartCount: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  filesDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  verificationCountersScope: VerificationCountersScope;
}

interface JobEnvelope {
  job: ImportJob;
}

const base = (projectId: string) => `/dashboard/projects/${projectId}/imports`;

const listKey = (projectId: string) => ["imports", projectId] as const;
const detailKey = (projectId: string, jobId: string) =>
  ["imports", projectId, jobId] as const;

/**
 * Recent import jobs for the project, newest first. Not polled — the
 * list view is a coarse "pick a job" affordance; only the selected job's
 * own `GET /:id` (`useImportJob` below) polls, per the shared
 * 120/min-per-project read budget (`IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE`)
 * documented in this feature's task-11 controller context.
 */
export function useImportJobs(projectId: string | undefined) {
  return useQuery({
    queryKey: listKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () => api<{ jobs: ImportJob[] }>(base(projectId!)),
  });
}

/**
 * A single job's status + counters — what the dashboard polls while a
 * dry run/commit/verification is in flight. Polling is gated by the
 * job's OWN status (`IMPORT_ACTIVE_POLL_STATUSES`): it starts only once
 * the job is actually doing something asynchronous, and stops the
 * instant a poll response reports a status outside that set — a
 * terminal outcome (COMPLETED/FAILED/CANCELLED/VERIFICATION_INCOMPLETE)
 * or a state with nothing running yet (PENDING_MAPPING/DRY_RUN_COMPLETE).
 */
export function useImportJob(projectId: string | undefined, jobId: string | undefined) {
  return useQuery({
    queryKey: detailKey(projectId ?? "", jobId ?? ""),
    enabled: Boolean(projectId && jobId),
    queryFn: () => api<JobEnvelope>(`${base(projectId!)}/${jobId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status && IMPORT_ACTIVE_POLL_STATUSES.has(status)
        ? IMPORT_POLL_INTERVAL_MS
        : false;
    },
  });
}

export interface UploadImportJobInput {
  file: File;
  sourceLabel?: string;
  /** Fired repeatedly during the upload with a 0-100 integer — see the
   *  module comment on why this is XHR-driven rather than routed through
   *  `api()`. */
  onProgress?: (percent: number) => void;
}

interface UploadEnvelope {
  data?: JobEnvelope;
  error?: { code: string; message: string };
}

const PERCENT_MAX = 100;

function uploadImportJobXhr(projectId: string, input: UploadImportJobInput): Promise<ImportJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ fileName: input.file.name });
    if (input.sourceLabel) qs.set("sourceLabel", input.sourceLabel);
    const url = `${API_BASE_URL}${base(projectId)}?${qs.toString()}`;
    xhr.open("POST", url, true);
    // Matches the dashboard-wide `credentials: "include"` convention
    // (see api.ts) — the Better Auth session cookie must round-trip on
    // this request the same as every other dashboard call.
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "text/csv");

    xhr.upload.onprogress = (event) => {
      if (!input.onProgress || !event.lengthComputable) return;
      input.onProgress(Math.round((event.loaded / event.total) * PERCENT_MAX));
    };

    xhr.onload = () => {
      let envelope: UploadEnvelope | null = null;
      try {
        envelope = JSON.parse(xhr.responseText) as UploadEnvelope;
      } catch {
        envelope = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && envelope?.data) {
        resolve(envelope.data.job);
        return;
      }
      reject(
        new ApiError(
          envelope?.error?.code ?? `HTTP_${xhr.status}`,
          envelope?.error?.message ?? xhr.statusText ?? "Upload failed",
          xhr.status,
        ),
      );
    };
    xhr.onerror = () => {
      reject(new ApiError("NETWORK_ERROR", "Network error during upload", 0));
    };

    xhr.send(input.file);
  });
}

export function useUploadImportJob(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadImportJobInput) => uploadImportJobXhr(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey(projectId) }),
  });
}

/**
 * Every job-lifecycle action below shares the same shape: POST to
 * `.../imports/:id/<action>`, then seed the detail query with the
 * response so the UI reflects the new status instantly rather than
 * waiting for the next poll tick, and invalidate the list so it picks
 * up the change too.
 */
//
// `commit` and `resume` (unlike `dry-run`, which flips the row to
// DRY_RUN_RUNNING synchronously before responding — see
// apps/api/src/routes/dashboard/imports.ts's module comment) return the
// job in its PRE-enqueue status: the actual RUNNING/VERIFYING flip
// happens inside the worker, asynchronously. Caching that stale status
// verbatim would make `useImportJob`'s status-gated `refetchInterval`
// decide there is nothing to poll for and never notice the job start —
// `optimisticStatus` patches the cached copy to the status the worker is
// expected to move to next, purely to keep polling ALIVE for one more
// tick; the next real `GET /:id` (already due at the top of that tick)
// overwrites it with the worker's true status regardless.
function useJobAction(
  projectId: string,
  jobId: string,
  action: string,
  optimisticStatus?: ImportJobStatus,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<JobEnvelope>(`${base(projectId)}/${jobId}/${action}`, { method: "POST" }),
    onSuccess: (data) => {
      const cached: JobEnvelope = optimisticStatus
        ? { job: { ...data.job, status: optimisticStatus } }
        : data;
      qc.setQueryData(detailKey(projectId, jobId), cached);
      void qc.invalidateQueries({ queryKey: listKey(projectId) });
    },
  });
}

export function useUpdateImportMapping(projectId: string, jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mapping: Record<string, CanonicalField>) =>
      api<JobEnvelope>(`${base(projectId)}/${jobId}/mapping`, {
        method: "PATCH",
        body: JSON.stringify({ mapping }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(detailKey(projectId, jobId), data);
      void qc.invalidateQueries({ queryKey: listKey(projectId) });
    },
  });
}

export function useStartDryRun(projectId: string, jobId: string) {
  return useJobAction(projectId, jobId, "dry-run");
}

export function useCommitImportJob(projectId: string, jobId: string) {
  return useJobAction(projectId, jobId, "commit", "RUNNING");
}

export function useResumeImportJob(projectId: string, jobId: string) {
  return useJobAction(projectId, jobId, "resume", "RUNNING");
}

export function useCancelImportJob(projectId: string, jobId: string) {
  return useJobAction(projectId, jobId, "cancel");
}

/** Report download URL — a plain `<a href>` navigation (matches
 *  settings/invoices.tsx's `pdfUrl` link), not a fetch: the response is
 *  a streamed NDJSON attachment (`Content-Disposition: attachment`),
 *  and Better Auth's session cookie rides along on the top-level GET
 *  navigation the same way it does for the invoice PDF link. */
export function importReportUrl(projectId: string, jobId: string): string {
  return `${API_BASE_URL}${base(projectId)}/${jobId}/report`;
}
