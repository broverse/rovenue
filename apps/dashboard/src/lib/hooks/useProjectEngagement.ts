import { useQuery } from "@tanstack/react-query";
import type { EngagementResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useProjectEngagement({
  projectId,
  from,
  to,
  enabled = true,
}: Params) {
  return useQuery({
    queryKey: ["metrics", "engagement", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<EngagementResponse>(
        rpc.dashboard.projects[":projectId"].metrics.engagement.$get({
          param: { projectId },
          query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        }),
      ),
  });
}
