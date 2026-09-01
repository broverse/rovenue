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
  ChartProceedsResponse,
  ChartRangeOption,
  ChartType,
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

// `estimated_proceeds` is a catalog entry but is NOT served by the
// `/series/:chartId` dispatcher — that response is one blended daily
// line, which cannot show a store with a configured commission rate
// beside one without (spec §4.3, task-7-context.md). It has its own
// per-store reader, `readProceeds` / `GET /proceeds`, mirroring how
// channels/funnel/heatmap already sit outside the dispatcher above.
export function useChartProceeds({ projectId, windowDays }: DataParams) {
  return useQuery({
    queryKey: ["charts", "proceeds", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ChartProceedsResponse>(
        `/dashboard/projects/${projectId}/charts/proceeds${buildWindowQs(windowDays)}`,
      ),
  });
}

// Powers the country-coverage note (spec §4.2): `platform` (the
// `store` dimension) is populated on every revenue event, while
// `country` is populated only when the store supplied one for that
// transaction. Comparing the two totals — done by the consuming
// component, not here — yields a real, data-derived coverage figure
// instead of a claim that can drift from what the pipeline actually
// captures.
export function useChartFilterOptions({ projectId, windowDays }: DataParams) {
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
