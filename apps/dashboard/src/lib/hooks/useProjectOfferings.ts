import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardOfferingCreateInput,
  DashboardOfferingRow,
  DashboardOfferingUpdateInput,
  DashboardOfferingsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

const root = (projectId: string) =>
  `/dashboard/projects/${projectId}/offerings` as const;

export function useProjectOfferings(projectId: string) {
  return useQuery({
    queryKey: ["offerings", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<DashboardOfferingsListResponse>(root(projectId)),
  });
}

export function useOfferingsByAccess(projectId: string, accessId: string | null) {
  return useQuery({
    queryKey: ["offerings", "by-access", projectId, accessId],
    enabled: Boolean(projectId && accessId),
    queryFn: () =>
      api<DashboardOfferingsListResponse>(
        `${root(projectId)}?accessId=${encodeURIComponent(accessId!)}`,
      ),
  });
}

export function useOfferingById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["offerings", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      api<{ offering: DashboardOfferingRow }>(`${root(projectId)}/${id}`),
  });
}

export function useCreateOffering(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardOfferingCreateInput) =>
      api<{ offering: DashboardOfferingRow }>(root(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offerings"] }),
  });
}

export function useUpdateOffering(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardOfferingUpdateInput) =>
      api<{ offering: DashboardOfferingRow }>(`${root(projectId)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offerings"] }),
  });
}

export function useDeleteOffering(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(`${root(projectId)}/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offerings"] }),
  });
}
