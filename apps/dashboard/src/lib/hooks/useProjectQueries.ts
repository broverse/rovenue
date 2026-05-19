import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardSavedQueriesListResponse,
  DashboardSavedQuery,
  DashboardSavedQueryCreateInput,
  DashboardSavedQueryUpdateInput,
  QueryExecuteRequest,
  QueryExecuteResponse,
  QuerySchemaResponse,
} from "@rovenue/shared";
import { api } from "../api";

// =============================================================
// Saved queries CRUD
// =============================================================

export function useSavedQueries(projectId: string) {
  return useQuery({
    queryKey: ["queries", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<DashboardSavedQueriesListResponse>(
        `/dashboard/projects/${projectId}/queries`,
      ),
  });
}

export function useSavedQueryById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["queries", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      api<{ query: DashboardSavedQuery }>(
        `/dashboard/projects/${projectId}/queries/${id}`,
      ),
  });
}

export function useCreateSavedQuery(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardSavedQueryCreateInput) =>
      api<{ query: DashboardSavedQuery }>(
        `/dashboard/projects/${projectId}/queries`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["queries", "list", projectId] }),
  });
}

export function useUpdateSavedQuery(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: { id: string } & DashboardSavedQueryUpdateInput) =>
      api<{ query: DashboardSavedQuery }>(
        `/dashboard/projects/${projectId}/queries/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ["queries", "list", projectId] });
      void qc.invalidateQueries({
        queryKey: ["queries", "detail", projectId, variables.id],
      });
    },
  });
}

export function useDeleteSavedQuery(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/queries/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["queries", "list", projectId] }),
  });
}

// =============================================================
// Execute + schema
// =============================================================

export function useExecuteQuery(projectId: string) {
  return useMutation({
    mutationFn: (body: QueryExecuteRequest) =>
      api<QueryExecuteResponse>(
        `/dashboard/projects/${projectId}/queries/execute`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  });
}

export function useQuerySchema(projectId: string) {
  return useQuery({
    queryKey: ["queries", "schema", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<QuerySchemaResponse>(
        `/dashboard/projects/${projectId}/queries/schema`,
      ),
  });
}
