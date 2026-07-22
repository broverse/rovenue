import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardPaywallCreateInput,
  DashboardPaywallRow,
  DashboardPaywallUpdateInput,
  DashboardPaywallsListResponse,
} from "@rovenue/shared";
import { rpc, unwrap } from "../api";

// Typed Hono RPC client (`rpc`/`unwrap`, inferred from AppType) — matches
// useFeatureFlags.ts / useExperiments.ts, not the untyped `api()` shim
// useProjectOfferings.ts still carries.

export function useProjectPaywalls(projectId: string) {
  return useQuery({
    queryKey: ["paywalls", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<DashboardPaywallsListResponse>(
        rpc.dashboard.projects[":projectId"].paywalls.$get({
          param: { projectId },
        }),
      ),
  });
}

export function usePaywallById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["paywalls", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      unwrap<{ paywall: DashboardPaywallRow }>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"].$get({
          param: { projectId, id: id! },
        }),
      ),
  });
}

export function useCreatePaywall(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardPaywallCreateInput) =>
      unwrap<{ paywall: DashboardPaywallRow }>(
        rpc.dashboard.projects[":projectId"].paywalls.$post({
          param: { projectId },
          json: body,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paywalls"] }),
  });
}

export function useUpdatePaywall(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardPaywallUpdateInput) =>
      unwrap<{ paywall: DashboardPaywallRow }>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"].$patch({
          param: { projectId, id },
          json: body,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paywalls"] }),
  });
}

export function useDeletePaywall(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap<{ deleted: true }>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"].$delete({
          param: { projectId, id },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["paywalls"] }),
  });
}
