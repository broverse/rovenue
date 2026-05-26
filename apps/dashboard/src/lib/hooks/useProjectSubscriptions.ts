import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BillingIssuesResponse,
  GrantSubscriptionRequest,
  ListScheduledActionsResponse,
  RenewalCalendarResponse,
  ScheduleActionRequest,
  ScheduledActionRow,
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

export function useGrantSubscription(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GrantSubscriptionRequest) =>
      api<{ purchaseId: string }>(
        `/dashboard/projects/${projectId}/subscriptions`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["subscriptions", "list", projectId] });
      void qc.invalidateQueries({ queryKey: ["subscriptions", "kpis", projectId] });
      void qc.invalidateQueries({ queryKey: ["subscriptions", "composition", projectId] });
    },
  });
}

export function useScheduleAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { purchaseId: string; body: ScheduleActionRequest }) =>
      api<ScheduledActionRow>(
        `/dashboard/projects/${projectId}/subscriptions/${vars.purchaseId}/schedule`,
        { method: "POST", body: JSON.stringify(vars.body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["subscriptions", "scheduled", projectId] });
    },
  });
}

export function useScheduledActions(projectId: string) {
  return useQuery({
    queryKey: ["subscriptions", "scheduled", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ListScheduledActionsResponse>(
        `/dashboard/projects/${projectId}/subscriptions/scheduled`,
      ),
  });
}

export function useDeleteScheduledAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<ScheduledActionRow>(
        `/dashboard/projects/${projectId}/subscriptions/scheduled/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["subscriptions", "scheduled", projectId] });
    },
  });
}

export function buildExportSubscriptionsUrl(
  projectId: string,
  scope: string,
  search: string,
): string {
  const params = new URLSearchParams({ scope });
  const trimmed = search.trim();
  if (trimmed) params.set("search", trimmed);
  return `/v1/dashboard/projects/${projectId}/subscriptions/export.csv?${params.toString()}`;
}
