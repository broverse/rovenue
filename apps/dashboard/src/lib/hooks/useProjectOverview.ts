import { useQuery } from "@tanstack/react-query";
import type { ProjectOverviewResponse } from "@rovenue/shared";
import { api } from "../api";

interface Params {
  projectId: string;
  /** Trailing window length in days. Defaults to 30 on the API. */
  windowDays?: number;
}

export function useProjectOverview({ projectId, windowDays }: Params) {
  return useQuery({
    queryKey: ["overview", projectId, { windowDays }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const qs = windowDays ? `?windowDays=${windowDays}` : "";
      return api<ProjectOverviewResponse>(
        `/dashboard/projects/${projectId}/overview${qs}`,
      );
    },
  });
}
