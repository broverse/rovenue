import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardProductCreateInput,
  DashboardProductImportInput,
  DashboardProductImportResponse,
  DashboardProductRow,
  DashboardProductUpdateInput,
  DashboardProductsListResponse,
  ProductTypeName,
} from "@rovenue/shared";
import { api } from "../api";

// =============================================================
// Products CRUD hooks
// =============================================================

export type ProductStoreFilter = "ios" | "android" | "web";

interface ListParams {
  projectId: string;
  search?: string;
  includeInactive?: boolean;
  types?: ReadonlyArray<ProductTypeName>;
  stores?: ReadonlyArray<ProductStoreFilter>;
  limit?: number;
}

export function useProjectProducts({
  projectId,
  search,
  includeInactive,
  types,
  stores,
  limit,
}: ListParams) {
  // Normalise so the queryKey stays stable across equivalent inputs.
  const typesKey = types && types.length > 0 ? [...types].sort() : undefined;
  const storesKey = stores && stores.length > 0 ? [...stores].sort() : undefined;
  return useInfiniteQuery({
    queryKey: [
      "products",
      "list",
      projectId,
      { search, includeInactive, limit, types: typesKey, stores: storesKey },
    ],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: DashboardProductsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (includeInactive !== undefined)
        params.set("includeInactive", String(includeInactive));
      if (typesKey) params.set("type", typesKey.join(","));
      if (storesKey) params.set("store", storesKey.join(","));
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

export function useImportProducts(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardProductImportInput) =>
      api<DashboardProductImportResponse>(
        `/dashboard/projects/${projectId}/products/import`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["products", "list", projectId] }),
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
