import { useQuery } from "@tanstack/react-query";
import type { LtvDistributionResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useProjectLtv(projectId: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "ltv", projectId],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<LtvDistributionResponse>(
        rpc.dashboard.projects[":projectId"].metrics.ltv.$get({
          param: { projectId },
        }),
      ),
  });
}
