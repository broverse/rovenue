import { useQuery } from "@tanstack/react-query";
import type { OfferingResolvedPrices } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

/** Store-price resolution is a live upstream call (Apple/Google/Stripe) — cache it briefly. */
export const RESOLVED_PRICES_STALE_MS = 60_000;

export function useOfferingResolvedPrices(projectId: string, offeringId: string | null) {
  return useQuery({
    queryKey: ["offerings", "resolved-prices", projectId, offeringId],
    enabled: Boolean(projectId && offeringId),
    staleTime: RESOLVED_PRICES_STALE_MS,
    queryFn: () =>
      unwrap<OfferingResolvedPrices>(
        rpc.dashboard.projects[":projectId"].offerings[":id"].resolved.$get({
          param: { projectId, id: offeringId! },
        }),
      ),
    select: (r) => r,
  });
}
