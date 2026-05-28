import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api";

// =============================================================
// Refund Shield — dashboard data hooks
// =============================================================
//
// Five backend endpoints, five hooks. Settings is read+write
// (mutation invalidates its own key + the metrics key so the
// onboarding wizard transitions cleanly to the live dashboard).
// Responses uses useInfiniteQuery because the backend returns
// cursor pagination keyed on `detectedAt`.

const BASE = (projectId: string) =>
  `/dashboard/projects/${encodeURIComponent(projectId)}/refund-shield`;

// ---- Settings ----------------------------------------------------

export interface RefundShieldSettings {
  enabled: boolean;
  responseDelayMinutes: number;
  consentAcknowledgedAt: string | null;
  consentAcknowledgedBy: string | null;
}

export function useRefundShieldSettings(projectId: string) {
  return useQuery({
    queryKey: ["refund-shield", "settings", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<{ settings: RefundShieldSettings }>(`${BASE(projectId)}/settings`),
    select: (res) => res.settings,
  });
}

export interface UpdateRefundShieldSettingsVars {
  enabled: boolean;
  responseDelayMinutes?: number;
  consentAcknowledged?: boolean;
}

export function useUpdateRefundShieldSettings(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: UpdateRefundShieldSettingsVars) => {
      const res = await api<{ settings: RefundShieldSettings }>(
        `${BASE(projectId)}/settings`,
        { method: "PUT", body: JSON.stringify(vars) },
      );
      return res.settings;
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["refund-shield", "settings", projectId],
      });
      qc.invalidateQueries({
        queryKey: ["refund-shield", "metrics", projectId],
      });
    },
  });
}

// ---- Responses (list + detail) ----------------------------------

export type RefundShieldStatus =
  | "PENDING"
  | "SENT"
  | "FAILED"
  | "SKIPPED_DISABLED"
  | "SKIPPED_NOT_FOUND";

export type RefundShieldOutcome =
  | "REFUND_APPROVED"
  | "REFUND_DECLINED"
  | "REFUND_REVERSED";

export interface RefundShieldResponseRow {
  id: string;
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: string;
  scheduledFor: string;
  sentAt: string | null;
  status: RefundShieldStatus;
  outcome: RefundShieldOutcome | null;
  outcomeReceivedAt: string | null;
  appleHttpStatus: number | null;
  error: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RefundShieldResponseDetail extends RefundShieldResponseRow {
  requestPayload: Record<string, unknown> | null;
  appleResponseBody: string | null;
}

export interface RefundShieldResponsesPage {
  responses: RefundShieldResponseRow[];
  nextCursor: string | null;
}

export interface RefundShieldResponsesFilters {
  status?: RefundShieldStatus;
  outcome?: RefundShieldOutcome;
  since?: string;
  until?: string;
  limit?: number;
}

export function useRefundShieldResponses(
  projectId: string,
  filters: RefundShieldResponsesFilters,
) {
  return useInfiniteQuery<RefundShieldResponsesPage>({
    queryKey: ["refund-shield", "responses", projectId, filters],
    enabled: Boolean(projectId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.outcome) params.set("outcome", filters.outcome);
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      if (filters.limit) params.set("limit", String(filters.limit));
      if (typeof pageParam === "string") params.set("cursor", pageParam);
      const qs = params.toString();
      return api<RefundShieldResponsesPage>(
        `${BASE(projectId)}/responses${qs ? `?${qs}` : ""}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useRefundShieldResponse(projectId: string, rid: string) {
  return useQuery({
    queryKey: ["refund-shield", "response", projectId, rid],
    enabled: Boolean(projectId && rid),
    queryFn: () =>
      api<{ response: RefundShieldResponseDetail }>(
        `${BASE(projectId)}/responses/${encodeURIComponent(rid)}`,
      ),
    select: (res) => res.response,
  });
}

// ---- Metrics ----------------------------------------------------

export interface RefundShieldMetrics {
  sentCount: number;
  outcomeCount: number;
  declinedCount: number;
  approvedCount: number;
  reversedCount: number;
  winRate: number;
  estimatedRevenueSavedCents: number;
  range: { since: string | null; until: string | null };
}

export interface RefundShieldMetricsFilters {
  since?: string;
  until?: string;
}

export function useRefundShieldMetrics(
  projectId: string,
  filters: RefundShieldMetricsFilters = {},
) {
  return useQuery({
    queryKey: ["refund-shield", "metrics", projectId, filters],
    enabled: Boolean(projectId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.since) params.set("since", filters.since);
      if (filters.until) params.set("until", filters.until);
      const qs = params.toString();
      return api<RefundShieldMetrics>(
        `${BASE(projectId)}/metrics${qs ? `?${qs}` : ""}`,
      );
    },
  });
}
