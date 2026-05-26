import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChartAnnotation,
  ChartAnnotationsResponse,
  ChartCatalogEntry,
  ChartCatalogResponse,
  ChartCategory,
  ChartChannelsResponse,
  ChartFilterOptionsResponse,
  ChartFunnelResponse,
  ChartHeatmapResponse,
  ChartRangeOption,
  ChartType,
  SavedChartView,
  SavedChartViewsResponse,
} from "@rovenue/shared";
import { api } from "../api";

// =============================================================
// Catalog (system defaults + project-shared custom rows)
// =============================================================

export function useChartCatalog(projectId: string) {
  return useQuery({
    queryKey: ["charts", "catalog", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ChartCatalogResponse>(
        `/dashboard/projects/${projectId}/charts/catalog`,
      ),
  });
}

export interface CreateCustomChartInput {
  name: string;
  category?: ChartCategory;
  chartType?: ChartType;
  range?: ChartRangeOption;
  config?: Record<string, unknown>;
}

export function useCreateCustomChart(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCustomChartInput) =>
      api<{ entry: ChartCatalogEntry }>(
        `/dashboard/projects/${projectId}/charts/catalog`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["charts", "catalog", projectId] }),
  });
}

export interface UpdateCustomChartInput {
  id: string;
  name?: string;
  category?: ChartCategory;
  chartType?: ChartType;
  range?: ChartRangeOption;
  config?: Record<string, unknown>;
}

export function useUpdateCustomChart(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateCustomChartInput) =>
      api<{ entry: ChartCatalogEntry }>(
        `/dashboard/projects/${projectId}/charts/catalog/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["charts", "catalog", projectId] }),
  });
}

export function useDeleteCustomChart(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/charts/catalog/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["charts", "catalog", projectId] }),
  });
}

// =============================================================
// Filter options
// =============================================================

export function useChartFilterOptions({
  projectId,
  windowDays,
}: DataParams) {
  return useQuery({
    queryKey: ["charts", "filter-options", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ChartFilterOptionsResponse>(
        `/dashboard/projects/${projectId}/charts/filter-options${buildWindowQs(windowDays)}`,
      ),
  });
}

// =============================================================
// Read-only chart data
// =============================================================

interface DataParams {
  projectId: string;
  windowDays?: number;
}

function buildWindowQs(windowDays?: number): string {
  return windowDays ? `?windowDays=${windowDays}` : "";
}

export function useChartChannels({ projectId, windowDays }: DataParams) {
  return useQuery({
    queryKey: ["charts", "channels", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ChartChannelsResponse>(
        `/dashboard/projects/${projectId}/charts/channels${buildWindowQs(windowDays)}`,
      ),
  });
}

export function useChartFunnel({ projectId, windowDays }: DataParams) {
  return useQuery({
    queryKey: ["charts", "funnel", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ChartFunnelResponse>(
        `/dashboard/projects/${projectId}/charts/funnel${buildWindowQs(windowDays)}`,
      ),
  });
}

export function useChartHeatmap({ projectId, windowDays }: DataParams) {
  return useQuery({
    queryKey: ["charts", "heatmap", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ChartHeatmapResponse>(
        `/dashboard/projects/${projectId}/charts/heatmap${buildWindowQs(windowDays)}`,
      ),
  });
}

// =============================================================
// Saved views CRUD
// =============================================================

export function useSavedChartViews(projectId: string) {
  return useQuery({
    queryKey: ["charts", "saved-views", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<SavedChartViewsResponse>(
        `/dashboard/projects/${projectId}/charts/saved-views`,
      ),
  });
}

export interface CreateSavedViewInput {
  name: string;
  description?: string | null;
  config?: Record<string, unknown>;
}

export function useCreateSavedView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSavedViewInput) =>
      api<{ view: SavedChartView }>(
        `/dashboard/projects/${projectId}/charts/saved-views`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["charts", "saved-views", projectId] }),
  });
}

export interface UpdateSavedViewInput {
  id: string;
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
}

export function useUpdateSavedView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateSavedViewInput) =>
      api<{ view: SavedChartView }>(
        `/dashboard/projects/${projectId}/charts/saved-views/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["charts", "saved-views", projectId] }),
  });
}

export function useDeleteSavedView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/charts/saved-views/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["charts", "saved-views", projectId] }),
  });
}

// =============================================================
// Annotations CRUD
// =============================================================

interface AnnotationsListParams {
  projectId: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function useChartAnnotations({
  projectId,
  from,
  to,
  limit,
}: AnnotationsListParams) {
  return useQuery({
    queryKey: ["charts", "annotations", projectId, { from, to, limit }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      return api<ChartAnnotationsResponse>(
        `/dashboard/projects/${projectId}/charts/annotations${qs ? `?${qs}` : ""}`,
      );
    },
  });
}

export interface CreateAnnotationInput {
  occurredAt: string;
  endsAt?: string | null;
  label: string;
  description?: string | null;
  color?: string | null;
  url?: string | null;
}

export function useCreateAnnotation(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAnnotationInput) =>
      api<{ annotation: ChartAnnotation }>(
        `/dashboard/projects/${projectId}/charts/annotations`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["charts", "annotations", projectId],
      }),
  });
}

export function useDeleteAnnotation(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(
        `/dashboard/projects/${projectId}/charts/annotations/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["charts", "annotations", projectId],
      }),
  });
}
