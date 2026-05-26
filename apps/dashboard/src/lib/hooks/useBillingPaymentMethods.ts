import { useQuery } from "@tanstack/react-query";
import type { PaymentMethodSummary } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useBillingPaymentMethods(projectId: string) {
  return useQuery({
    queryKey: ["billing", "payment-methods", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<PaymentMethodSummary[]>(
        rpc.dashboard.projects[":projectId"].billing["payment-methods"].$get({
          param: { projectId },
        }),
      ),
  });
}
