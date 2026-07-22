import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardPlacementCreateInput,
  DashboardPlacementMetricsResponse,
  DashboardPlacementRow,
  DashboardPlacementUpdateInput,
  DashboardPlacementsListResponse,
} from "@rovenue/shared";
import { rpc, unwrap } from "../api";

// Typed Hono RPC client (`rpc`/`unwrap`, inferred from AppType) — mirrors
// useProjectPaywalls.ts exactly (same CRUD shape, same query-key
// convention: ["placements", ...]).

export function useProjectPlacements(projectId: string) {
  return useQuery({
    queryKey: ["placements", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<DashboardPlacementsListResponse>(
        rpc.dashboard.projects[":projectId"].placements.$get({
          param: { projectId },
        }),
      ),
  });
}

export function usePlacementById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["placements", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      unwrap<{ placement: DashboardPlacementRow }>(
        rpc.dashboard.projects[":projectId"].placements[":id"].$get({
          param: { projectId, id: id! },
        }),
      ),
  });
}

export function useCreatePlacement(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardPlacementCreateInput) =>
      unwrap<{ placement: DashboardPlacementRow }>(
        rpc.dashboard.projects[":projectId"].placements.$post({
          param: { projectId },
          json: body,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["placements"] }),
  });
}

export function useUpdatePlacement(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardPlacementUpdateInput) =>
      unwrap<{ placement: DashboardPlacementRow }>(
        rpc.dashboard.projects[":projectId"].placements[":id"].$patch({
          param: { projectId, id },
          json: body,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["placements"] }),
  });
}

export function useDeletePlacement(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<{ deleted: true }>(
        rpc.dashboard.projects[":projectId"].placements[":id"].$delete({
          param: { projectId, id },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["placements"] }),
  });
}

/**
 * Views/unique-views (+purchases/CR) for one placement — backs the
 * metrics card on the placement editor. Always resolves to a value
 * (all-zero when ClickHouse is unconfigured; see
 * services/placement-metrics.ts on the API side), so callers don't
 * need a separate "unavailable" branch.
 */
export function usePlacementMetrics(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["placements", "metrics", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      unwrap<DashboardPlacementMetricsResponse>(
        rpc.dashboard.projects[":projectId"].placements[":id"].metrics.$get({
          param: { projectId, id: id! },
        }),
      ),
  });
}
