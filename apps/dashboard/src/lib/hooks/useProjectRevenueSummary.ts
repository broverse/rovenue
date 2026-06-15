import { useQuery } from "@tanstack/react-query";
import type { RevenueSummaryResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  /** Optional ISO-8601 window override. Defaults to last 30 days on the API. */
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useProjectRevenueSummary({
  projectId,
  from,
  to,
  enabled = true,
}: Params) {
  return useQuery({
    queryKey: ["metrics", "summary", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<RevenueSummaryResponse>(
        rpc.dashboard.projects[":projectId"].metrics.summary.$get({
          param: { projectId },
          query: {
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
        }),
      ),
  });
}
