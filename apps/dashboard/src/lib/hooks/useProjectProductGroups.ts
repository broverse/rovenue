import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardProductGroupCreateInput,
  DashboardProductGroupRow,
  DashboardProductGroupUpdateInput,
  DashboardProductGroupsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

export function useProjectProductGroups(projectId: string) {
  return useQuery({
    queryKey: ["product-groups", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<DashboardProductGroupsListResponse>(
        `/dashboard/projects/${projectId}/product-groups`,
      ),
  });
}

export function useProductGroupById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["product-groups", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      api<{ group: DashboardProductGroupRow }>(
        `/dashboard/projects/${projectId}/product-groups/${id}`,
      ),
  });
}

export function useCreateProductGroup(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardProductGroupCreateInput) =>
      api<{ group: DashboardProductGroupRow }>(
        `/dashboard/projects/${projectId}/product-groups`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["product-groups", "list", projectId] }),
  });
}

export function useUpdateProductGroup(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: { id: string } & DashboardProductGroupUpdateInput) =>
      api<{ group: DashboardProductGroupRow }>(
        `/dashboard/projects/${projectId}/product-groups/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({
        queryKey: ["product-groups", "list", projectId],
      });
      void qc.invalidateQueries({
        queryKey: ["product-groups", "detail", projectId, variables.id],
      });
    },
  });
}

export function useDeleteProductGroup(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/product-groups/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["product-groups", "list", projectId] }),
  });
}
