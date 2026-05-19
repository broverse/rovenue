import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CohortRetentionResponse,
  CohortRow,
  CohortRule,
  CohortSyncDestination,
  CohortsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

export function useProjectCohorts(projectId: string) {
  return useQuery({
    queryKey: ["cohorts", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<CohortsListResponse>(`/dashboard/projects/${projectId}/cohorts`),
  });
}

export function useCohortById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["cohorts", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      api<{ cohort: CohortRow }>(
        `/dashboard/projects/${projectId}/cohorts/${id}`,
      ),
  });
}

export interface CohortRetentionParams {
  projectId: string;
  id: string;
  granularity?: "day" | "week" | "month";
  periods?: number;
}

export function useCohortRetention({
  projectId,
  id,
  granularity,
  periods,
}: CohortRetentionParams) {
  return useQuery({
    queryKey: ["cohorts", "retention", projectId, id, { granularity, periods }],
    enabled: Boolean(projectId && id),
    queryFn: () => {
      const params = new URLSearchParams();
      if (granularity) params.set("granularity", granularity);
      if (periods) params.set("periods", String(periods));
      const qs = params.toString();
      return api<CohortRetentionResponse>(
        `/dashboard/projects/${projectId}/cohorts/${id}/retention${qs ? `?${qs}` : ""}`,
      );
    },
  });
}

export interface CreateCohortInput {
  name: string;
  description?: string | null;
  rules: CohortRule;
  syncDestinations?: CohortSyncDestination[];
  metadata?: Record<string, unknown>;
}

export function useCreateCohort(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCohortInput) =>
      api<{ cohort: CohortRow }>(`/dashboard/projects/${projectId}/cohorts`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["cohorts", "list", projectId] }),
  });
}

export interface UpdateCohortInput {
  id: string;
  name?: string;
  description?: string | null;
  rules?: CohortRule;
  syncDestinations?: CohortSyncDestination[];
  metadata?: Record<string, unknown>;
}

export function useUpdateCohort(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateCohortInput) =>
      api<{ cohort: CohortRow }>(
        `/dashboard/projects/${projectId}/cohorts/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({
        queryKey: ["cohorts", "list", projectId],
      });
      void qc.invalidateQueries({
        queryKey: ["cohorts", "detail", projectId, variables.id],
      });
      void qc.invalidateQueries({
        queryKey: ["cohorts", "retention", projectId, variables.id],
      });
    },
  });
}

export function useDeleteCohort(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/cohorts/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["cohorts", "list", projectId] }),
  });
}
