import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export type RefundKind = "transaction" | "subscription";

type RefundResponse = {
  status: "refund_requested";
  store: "stripe" | "play";
  reference: string;
};

// Both kinds hit the same `refundTransaction` service server-side; they differ
// only in the route they POST to and which caches the result invalidates.
const SUBSCRIPTION_QUERIES = ["list", "kpis", "composition", "scope-counts"] as const;

export function useRefund(projectId: string, kind: RefundKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<RefundResponse>(
        kind === "transaction"
          ? `/dashboard/projects/${projectId}/transactions/${id}/refund`
          : `/dashboard/projects/${projectId}/subscriptions/${id}/refund`,
        { method: "POST" },
      ),
    onSuccess: () => {
      if (kind === "transaction") {
        void qc.invalidateQueries({ queryKey: ["transactions", "list"] });
        return;
      }
      for (const q of SUBSCRIPTION_QUERIES) {
        void qc.invalidateQueries({ queryKey: ["subscriptions", q, projectId] });
      }
    },
  });
}
