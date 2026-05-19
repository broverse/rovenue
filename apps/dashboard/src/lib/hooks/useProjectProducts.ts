import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardProductCreateInput,
  DashboardProductRow,
  DashboardProductUpdateInput,
  DashboardProductsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

// =============================================================
// Products CRUD hooks
// =============================================================

interface ListParams {
  projectId: string;
  search?: string;
  includeInactive?: boolean;
  limit?: number;
}

export function useProjectProducts({ projectId, search, includeInactive, limit }: ListParams) {
  return useInfiniteQuery({
    queryKey: ["products", "list", projectId, { search, includeInactive, limit }],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: DashboardProductsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (includeInactive !== undefined)
        params.set("includeInactive", String(includeInactive));
      if (limit) params.set("limit", String(limit));
      if (pageParam) params.set("cursor", pageParam);
      const qs = params.toString();
      return api<DashboardProductsListResponse>(
        `/dashboard/projects/${projectId}/products${qs ? `?${qs}` : ""}`,
      );
    },
  });
}

export function useProductById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["products", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      api<{ product: DashboardProductRow }>(
        `/dashboard/projects/${projectId}/products/${id}`,
      ),
  });
}

export function useCreateProduct(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardProductCreateInput) =>
      api<{ product: DashboardProductRow }>(
        `/dashboard/projects/${projectId}/products`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["products", "list", projectId] }),
  });
}

export function useUpdateProduct(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & DashboardProductUpdateInput) =>
      api<{ product: DashboardProductRow }>(
        `/dashboard/projects/${projectId}/products/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ["products", "list", projectId] });
      void qc.invalidateQueries({
        queryKey: ["products", "detail", projectId, variables.id],
      });
    },
  });
}

export function useDeleteProduct(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/products/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["products", "list", projectId] }),
  });
}
