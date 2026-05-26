import { useQuery } from "@tanstack/react-query";
import type { InvoiceSummary } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useBillingInvoices(projectId: string) {
  return useQuery({
    queryKey: ["billing", "invoices", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<InvoiceSummary[]>(
        rpc.dashboard.projects[":projectId"].billing.invoices.$get({
          param: { projectId },
        }),
      ),
  });
}
