import { useQuery } from "@tanstack/react-query";
import type { LtvPredictionResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useProjectLtvPrediction(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "ltv-prediction", projectId],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<LtvPredictionResponse>(
        rpc.dashboard.projects[":projectId"].metrics["ltv-prediction"].$get({
          param: { projectId },
          query: {},
        }),
      ),
  });
}
