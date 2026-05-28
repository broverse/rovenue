import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardAccessCreateInput,
  DashboardAccessListResponse,
  DashboardAccessRow,
  DashboardAccessUpdateInput,
} from "@rovenue/shared";
import { api } from "../api";

const root = (projectId: string) =>
  `/dashboard/projects/${projectId}/access` as const;

export function useProjectAccess(projectId: string) {
  return useQuery({
    queryKey: ["access", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<DashboardAccessListResponse>(root(projectId)),
  });
}

export function useAccessById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["access", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () => api<DashboardAccessRow>(`${root(projectId)}/${id}`),
  });
}

export function useCreateAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardAccessCreateInput) =>
      api<DashboardAccessRow>(root(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access"] }),
  });
}

export function useUpdateAccess(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardAccessUpdateInput) =>
      api<DashboardAccessRow>(`${root(projectId)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access"] }),
  });
}

export function useDeleteAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`${root(projectId)}/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access"] }),
  });
}
