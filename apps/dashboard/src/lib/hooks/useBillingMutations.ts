import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UpgradeResponse } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useStartUpgrade(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap<UpgradeResponse>(
        rpc.dashboard.projects[":projectId"].billing.upgrade.$post({
          param: { projectId },
          json: { cycle: "monthly" },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["billing", "summary", projectId],
      });
    },
  });
}

export function useStartAddCard(projectId: string) {
  return useMutation({
    mutationFn: () =>
      unwrap<UpgradeResponse>(
        rpc.dashboard.projects[":projectId"].billing["payment-methods"].$post({
          param: { projectId },
        }),
      ),
  });
}

export function useSetDefaultPaymentMethod(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pmId: string) =>
      unwrap<{ id: string }>(
        rpc.dashboard.projects[":projectId"].billing["payment-methods"][
          ":pmId"
        ].default.$post({ param: { projectId, pmId } }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["billing", "payment-methods", projectId],
      });
      void qc.invalidateQueries({
        queryKey: ["billing", "summary", projectId],
      });
    },
  });
}

export function useDetachPaymentMethod(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pmId: string) =>
      unwrap<{ detaching: boolean }>(
        rpc.dashboard.projects[":projectId"].billing["payment-methods"][
          ":pmId"
        ].$delete({ param: { projectId, pmId } }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["billing", "payment-methods", projectId],
      });
    },
  });
}
