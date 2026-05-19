import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  DashboardExperimentStatus,
  DashboardExperimentType,
  ExperimentDetailResponse,
  ExperimentLifecycleResponse,
  ExperimentListResponse,
  ExperimentListItem,
  StopExperimentRequest,
} from "@rovenue/shared";
import { api } from "../api";

interface ListParams {
  projectId: string;
  status?: DashboardExperimentStatus;
  type?: DashboardExperimentType;
}

export function useExperiments({ projectId, status, type }: ListParams) {
  return useQuery({
    queryKey: ["experiments", projectId, { status, type }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const params = new URLSearchParams({ projectId });
      if (status) params.set("status", status);
      if (type) params.set("type", type);
      return api<ExperimentListResponse>(
        `/dashboard/experiments?${params.toString()}`,
      );
    },
    select: (res) => res.experiments,
  });
}

export function useExperiment(id: string | undefined) {
  return useQuery({
    queryKey: ["experiment", id],
    enabled: Boolean(id),
    queryFn: () =>
      api<ExperimentDetailResponse>(`/dashboard/experiments/${id}`),
  });
}

// =============================================================
// Lifecycle mutations
// =============================================================
//
// Each mutation invalidates the project's experiment list so the
// status dots + scope counts refresh, plus the specific detail
// query for the experiment it touched.

function lifecycleAction(action: "start" | "pause" | "resume") {
  return (id: string) =>
    api<ExperimentLifecycleResponse>(
      `/dashboard/experiments/${id}/${action}`,
      { method: "POST" },
    );
}

function useLifecycleMutation(
  mutationFn: (id: string) => Promise<ExperimentLifecycleResponse>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
      qc.invalidateQueries({ queryKey: ["experiment", data.experiment.id] });
    },
  });
}

export function useStartExperiment() {
  return useLifecycleMutation(lifecycleAction("start"));
}

export function usePauseExperiment() {
  return useLifecycleMutation(lifecycleAction("pause"));
}

export function useResumeExperiment() {
  return useLifecycleMutation(lifecycleAction("resume"));
}

export interface StopExperimentVars {
  id: string;
  body?: StopExperimentRequest;
}

export function useStopExperiment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: StopExperimentVars) =>
      api<ExperimentLifecycleResponse>(
        `/dashboard/experiments/${id}/stop`,
        {
          method: "POST",
          body: body ? JSON.stringify(body) : undefined,
        },
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["experiments"] });
      qc.invalidateQueries({ queryKey: ["experiment", data.experiment.id] });
      if (data.promotedFlag) {
        qc.invalidateQueries({ queryKey: ["feature-flags"] });
      }
    },
  });
}

export type { ExperimentListItem };
