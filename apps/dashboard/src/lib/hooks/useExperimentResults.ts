import { useQuery } from "@tanstack/react-query";
import type { ExperimentResultsResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

// Typed Hono RPC client (`rpc`/`unwrap`, inferred from AppType) — mirrors
// useProjectPaywalls.ts / useProjectPlacements.ts, not the untyped `api()`
// shim. The endpoint lives under `/dashboard/experiments/:id/results`
// (the experiment's projectId is resolved server-side from the row, see
// apps/api/src/routes/dashboard/experiments.ts) — `projectId` here only
// scopes the query key so results get invalidated/refetched alongside
// the rest of that project's experiment data.

export function useExperimentResults(
  projectId: string,
  experimentId: string | undefined,
) {
  return useQuery({
    queryKey: ["experiments", "results", projectId, experimentId],
    enabled: Boolean(projectId && experimentId),
    queryFn: () =>
      unwrap<ExperimentResultsResponse>(
        rpc.dashboard.experiments[":id"].results.$get({
          param: { id: experimentId! },
        }),
      ),
  });
}
