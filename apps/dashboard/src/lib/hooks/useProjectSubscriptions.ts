import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  BillingIssuesResponse,
  RenewalCalendarResponse,
  SubscriptionScopeName,
  SubscriptionsCompositionResponse,
  SubscriptionsKpis,
  SubscriptionsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

interface ListParams {
  projectId: string;
  scope: SubscriptionScopeName;
  search?: string;
  limit?: number;
}

export function useProjectSubscriptions({ projectId, scope, search, limit }: ListParams) {
  return useInfiniteQuery({
    queryKey: ["subscriptions", "list", projectId, scope, search ?? "", limit],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: SubscriptionsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("scope", scope);
      if (limit) params.set("limit", String(limit));
      if (search) params.set("search", search);
      if (pageParam) params.set("cursor", pageParam);
      return api<SubscriptionsListResponse>(
        `/dashboard/projects/${projectId}/subscriptions?${params.toString()}`,
      );
    },
  });
}

export function useProjectSubscriptionsKpis(projectId: string) {
  return useQuery({
    queryKey: ["subscriptions", "kpis", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<SubscriptionsKpis>(
        `/dashboard/projects/${projectId}/subscriptions/kpis`,
      ),
  });
}

export function useProjectSubscriptionsComposition(projectId: string) {
  return useQuery({
    queryKey: ["subscriptions", "composition", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<SubscriptionsCompositionResponse>(
        `/dashboard/projects/${projectId}/subscriptions/composition`,
      ),
  });
}

export function useProjectRenewalCalendar({
  projectId,
  pastDays,
  futureDays,
}: {
  projectId: string;
  pastDays?: number;
  futureDays?: number;
}) {
  return useQuery({
    queryKey: ["subscriptions", "renewal-calendar", projectId, { pastDays, futureDays }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (pastDays !== undefined) params.set("pastDays", String(pastDays));
      if (futureDays !== undefined) params.set("futureDays", String(futureDays));
      const qs = params.toString();
      return api<RenewalCalendarResponse>(
        `/dashboard/projects/${projectId}/subscriptions/renewal-calendar${qs ? `?${qs}` : ""}`,
      );
    },
  });
}

export function useProjectBillingIssues(projectId: string, limit?: number) {
  return useQuery({
    queryKey: ["subscriptions", "billing-issues", projectId, { limit }],
    enabled: Boolean(projectId),
    queryFn: () => {
      const qs = limit ? `?limit=${limit}` : "";
      return api<BillingIssuesResponse>(
        `/dashboard/projects/${projectId}/subscriptions/billing-issues${qs}`,
      );
    },
  });
}
