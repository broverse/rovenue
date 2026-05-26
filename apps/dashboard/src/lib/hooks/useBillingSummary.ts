import { useQuery } from "@tanstack/react-query";
import type { BillingSummary } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useBillingSummary(projectId: string) {
  return useQuery({
    queryKey: ["billing", "summary", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<BillingSummary>(
        rpc.dashboard.projects[":projectId"].billing.$get({
          param: { projectId },
        }),
      ),
  });
}
