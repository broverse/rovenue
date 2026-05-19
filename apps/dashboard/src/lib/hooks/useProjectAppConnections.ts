import { useQuery } from "@tanstack/react-query";
import type { AppConnectionsResponse } from "@rovenue/shared";
import { api } from "../api";

export function useProjectAppConnections(projectId: string) {
  return useQuery({
    queryKey: ["apps", "connections", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<AppConnectionsResponse>(
        `/dashboard/projects/${projectId}/apps/connections`,
      ),
  });
}
