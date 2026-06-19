import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BillingIssuesResponse,
  GrantSubscriptionRequest,
  ListScheduledActionsResponse,
  RenewalCalendarResponse,
  ScheduleActionRequest,
  ScheduledActionRow,
  SubscriptionScopeName,
  SubscriptionSortKey,
  SubscriptionStoreCode,
  SubscriptionsCompositionResponse,
  SubscriptionsKpis,
  SubscriptionsListResponse,
  SubscriptionsScopeCountsResponse,
} from "@rovenue/shared";
import { api } from "../api";

export interface SubscriptionsListParams {
  projectId: string;
  scope: SubscriptionScopeName;
  sort: SubscriptionSortKey;
  search?: string;
  limit?: number;
  store?: ReadonlyArray<SubscriptionStoreCode>;
  productId?: ReadonlyArray<string>;
  autoRenew?: boolean;
  isTrial?: boolean;
  isIntro?: boolean;
  hasIssue?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
}

// Stable, normalized key shape for React Query — alphabetized arrays so
// equivalent filter sets share a cache entry.
function normalizedKey(p: SubscriptionsListParams) {
  return {
    scope: p.scope,
    sort: p.sort,
    search: p.search ?? "",
    limit: p.limit ?? null,
    store: p.store && p.store.length > 0 ? [...p.store].sort() : null,
    productId:
      p.productId && p.productId.length > 0 ? [...p.productId].sort() : null,
    autoRenew: p.autoRenew ?? null,
    isTrial: p.isTrial ?? null,
    isIntro: p.isIntro ?? null,
    hasIssue: p.hasIssue ?? null,
    purchasedFrom: p.purchasedFrom ?? null,
    purchasedTo: p.purchasedTo ?? null,
    expiresFrom: p.expiresFrom ?? null,
    expiresTo: p.expiresTo ?? null,
  };
}

function buildListParams(
  p: SubscriptionsListParams,
  cursor?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("scope", p.scope);
  params.set("sort", p.sort);
  if (p.limit) params.set("limit", String(p.limit));
  if (p.search) params.set("search", p.search);
  if (p.store && p.store.length > 0) params.set("store", p.store.join(","));
  if (p.productId && p.productId.length > 0)
    params.set("productId", p.productId.join(","));
  if (p.autoRenew !== undefined) params.set("autoRenew", String(p.autoRenew));
  if (p.isTrial !== undefined) params.set("isTrial", String(p.isTrial));
  if (p.isIntro !== undefined) params.set("isIntro", String(p.isIntro));
  if (p.hasIssue) params.set("hasIssue", "true");
  if (p.purchasedFrom) params.set("purchasedFrom", p.purchasedFrom);
  if (p.purchasedTo) params.set("purchasedTo", p.purchasedTo);
  if (p.expiresFrom) params.set("expiresFrom", p.expiresFrom);
  if (p.expiresTo) params.set("expiresTo", p.expiresTo);
  if (cursor) params.set("cursor", cursor);
  return params;
}

export function useProjectSubscriptions(p: SubscriptionsListParams) {
  return useInfiniteQuery({
    queryKey: ["subscriptions", "list", p.projectId, normalizedKey(p)],
    enabled: Boolean(p.projectId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: SubscriptionsListResponse) =>
      lastPage.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = buildListParams(p, pageParam).toString();
      return api<SubscriptionsListResponse>(
        `/dashboard/projects/${p.projectId}/subscriptions?${qs}`,
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

export function useProjectSubscriptionsScopeCounts(projectId: string) {
  return useQuery({
    queryKey: ["subscriptions", "scope-counts", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<SubscriptionsScopeCountsResponse>(
        `/dashboard/projects/${projectId}/subscriptions/scope-counts`,
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
      void qc.invalidateQueries({ queryKey: ["subscriptions", "scope-counts", projectId] });
    },
  });
}

type RefundResponse = {
  status: "refund_requested";
  store: "stripe" | "play";
  reference: string;
};

export function useRefundSubscription(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subscriptionId: string) =>
      api<RefundResponse>(
        `/dashboard/projects/${projectId}/subscriptions/${subscriptionId}/refund`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["subscriptions", "list", projectId] });
      void qc.invalidateQueries({ queryKey: ["subscriptions", "kpis", projectId] });
      void qc.invalidateQueries({ queryKey: ["subscriptions", "composition", projectId] });
      void qc.invalidateQueries({ queryKey: ["subscriptions", "scope-counts", projectId] });
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
