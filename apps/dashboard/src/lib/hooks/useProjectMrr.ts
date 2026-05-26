import { useQuery } from "@tanstack/react-query";
import type { MrrSeriesResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  /** Optional ISO-8601 window override. Defaults to last 30 days on the API. */
  from?: string;
  to?: string;
  /** Skip the request without unmounting the consumer. Used by the
   *  MRR chart panel to gate the "previous period" fetch behind the
   *  Compare toggle. */
  enabled?: boolean;
}

export function useProjectMrr({ projectId, from, to, enabled = true }: Params) {
  return useQuery({
    queryKey: ["metrics", "mrr", projectId, { from, to }],
    enabled: Boolean(projectId) && enabled,
    queryFn: () =>
      unwrap<MrrSeriesResponse>(
        rpc.dashboard.projects[":projectId"].metrics.mrr.$get({
          param: { projectId },
          query: {
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
        }),
      ),
  });
}
