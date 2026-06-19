import { useQuery } from "@tanstack/react-query";
import type { BillingUsage } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export type { UsageMeterKey, UsageMeter, BillingUsage } from "@rovenue/shared";

export function useBillingUsage(projectId: string) {
  return useQuery({
    queryKey: ["billing", "usage", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<BillingUsage>(
        rpc.dashboard.projects[":projectId"].billing.usage.$get({
          param: { projectId },
        }),
      ),
  });
}
