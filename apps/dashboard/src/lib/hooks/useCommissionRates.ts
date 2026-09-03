import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubscriptionStoreCode } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

// =============================================================
// Commission-rate hooks
// =============================================================
//
// Wraps `/dashboard/projects/:projectId/commission-rates(/:store)`
// (apps/api/src/routes/dashboard/commission-rates.ts). GET is any
// project member (capability "project:read"); PUT/DELETE require
// capability "project:settings:write" — enforced server-side only, the
// same convention this dashboard uses for every other OWNER/ADMIN
// write (see project-notification-defaults's route comment). This
// module surfaces whatever error string the API returns; it does not
// re-implement the capability check client-side.
//
// A store absent from `rates` has NO configured rate — render "not
// configured", never a synthesized 0% (see commission-rates.ts's
// header and proceeds.ts).

export interface CommissionRate {
  store: SubscriptionStoreCode;
  rate: number;
}

const queryKey = (projectId: string) => ["commission-rates", projectId] as const;

export function useCommissionRates(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKey(projectId ?? ""),
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ rates: CommissionRate[] }>(
        rpc.dashboard.projects[":projectId"]["commission-rates"].$get({
          param: { projectId: projectId! },
        }),
      ),
    select: (r) => r.rates,
  });
}

export function useUpdateCommissionRate(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ store, rate }: { store: SubscriptionStoreCode; rate: number }) =>
      unwrap<CommissionRate>(
        rpc.dashboard.projects[":projectId"]["commission-rates"][":store"].$put({
          param: { projectId, store },
          json: { rate },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKey(projectId) });
    },
  });
}

export function useDeleteCommissionRate(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (store: SubscriptionStoreCode) =>
      unwrap<{ ok: true }>(
        rpc.dashboard.projects[":projectId"]["commission-rates"][":store"].$delete({
          param: { projectId, store },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKey(projectId) });
    },
  });
}
