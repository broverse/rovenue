import { useQuery } from "@tanstack/react-query";
import type { MrrSeriesResponse } from "@rovenue/shared";
import { api } from "../api";

interface Params {
  projectId: string;
  /** Optional ISO-8601 window override. Defaults to last 30 days on the API. */
  from?: string;
  to?: string;
}

export function useProjectMrr({ projectId, from, to }: Params) {
  return useQuery({
    queryKey: ["metrics", "mrr", projectId, { from, to }],
    enabled: Boolean(projectId),
    // The CH read is freshly aggregated each call but the page
    // doesn't need second-by-second updates — let the dashboard's
    // global staleTime (30s) govern background refetch.
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return api<MrrSeriesResponse>(
        `/dashboard/projects/${projectId}/metrics/mrr${qs ? `?${qs}` : ""}`,
      );
    },
  });
}
