import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

type RefundResponse = { status: "refund_requested"; store: "stripe" | "play"; reference: string };

export function useRefundTransaction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (transactionId: string) =>
      api<RefundResponse>(
        `/dashboard/projects/${projectId}/transactions/${transactionId}/refund`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["transactions", "list"] }),
  });
}
