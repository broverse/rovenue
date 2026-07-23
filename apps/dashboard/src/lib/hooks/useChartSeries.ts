import { useQuery } from "@tanstack/react-query";
import type { ChartSeriesResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

interface Params {
  projectId: string;
  /** Catalog id, e.g. `"churn"`, `"paywall_view_rate"`. Every id is
   *  valid to request — unwired ids come back `supported: false`
   *  rather than 404ing. */
  chartId: string;
  windowDays: number;
}

export function useChartSeries({ projectId, chartId, windowDays }: Params) {
  return useQuery({
    queryKey: ["charts", "series", projectId, chartId, { windowDays }],
    enabled: Boolean(projectId) && Boolean(chartId),
    queryFn: () =>
      unwrap<ChartSeriesResponse>(
        rpc.dashboard.projects[":projectId"].charts.series[":chartId"].$get({
          param: { projectId, chartId },
          query: { windowDays },
        }),
      ),
  });
}
